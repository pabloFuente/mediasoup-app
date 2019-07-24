const SERVER_CONFIG = require('./config');
const MediaSoup = require('mediasoup');
const Express = require('express');
const Fs = require('fs');
const Https = require('https');
const SocketIO = require('socket.io');
const Ip = require('ip');
const Colors = require('colors/safe');

console.log('Internal IP is %s', Ip.address());

expressApp = Express();
expressApp.use(Express.json());
expressApp.use(Express.static(__dirname));

expressApp.use((error, req, res, next) => {
    if (error) {
        console.warn('Express app error,', error.message);
        error.status = error.status || (error.name === 'TypeError' ? 400 : 500);
        res.statusMessage = error.message;
        res.status(error.status).send(String(error));
    } else {
        next();
    }
});

const tls = {
    cert: Fs.readFileSync('./cert/cert.pem'),
    key: Fs.readFileSync('./cert/key.pem'),
};
httpsServer = Https.createServer(tls, expressApp);
httpsServer.on('error', (err) => {
    console.error('starting HTTPS server failed,', err.message);
});

httpsServer.listen(SERVER_CONFIG.port, SERVER_CONFIG.ip, () => {
    console.log('Server is running and listening on https://%s:%s', SERVER_CONFIG.ip, SERVER_CONFIG.port);
});

// A worker represents a mediasoup C++ subprocess that runs in a single CPU core and handles Router instances
let msWorker;

// A router enables injection, selection and forwarding of media streams through Transport instances created on it.
// Developers may think of a mediasoup router as if it were a “multi-party conference room”, although mediasoup is
// much more low level than that and doesn't constrain itself to specific high level use cases (for instance, a
// “multi-party conference room” could involve various mediasoup routers, even in different physicals hosts)
let msRouter;

// A transport connects an endpoint with a mediasoup router and enables transmission of media in both directions by
// means of Producer and Consumer instances created on it. mediasoup implements the following transport classes:
// [WebRtcTransport, PlainRtpTransport, PipeTransport]
let msTransport;

// A producer represents an audio or video source being injected into a mediasoup router. It's created on top of
// a transport that defines how the media packets are carried
let msProducer;

// A consumer represents an audio or video source being forwarded from a mediasoup router to an endpoint. It's
// created on top of a transport that defines how the media packets are carried
let msConsumer;

// Collection of sessions
let sessions = new Map();
// Collection of users (websocket connections)
let finalUsers = new Map();

const socketServer = SocketIO(httpsServer, {
    serveClient: false,
    path: SERVER_CONFIG.path,
    log: false,
    pingInterval: SERVER_CONFIG.ws.pingInterval,
    pingTimeout: SERVER_CONFIG.ws.pingTimeout,
    transports: ['websocket']
});

socketServer.on('connection', socket => {
    console.log('Client connected from %s:%s', socket.request.connection.remoteAddress, socket.request.connection.remotePort);

    finalUsers.set(socket.id, {
        ws: socket,
        producerTransports: new Map(),
        consumerTransports: new Map(),
        producers: new Map(),
        consumers: new Map()
    });
    console.log(finalUsers.keys());

    socket.on('disconnect', reason => {
        console.log('WebSocket %s is closed. Reason: %s', socket.id, reason);
        removeFinalUser(socket.id);
    });

    socket.on('error', error => {
        console.error('Error on websocket ' + socket.id, error);
    });

    socket.on('joinRoom', async (data, callback) => {
        const sessionId = data.sessionId;
        let session = sessions.get(sessionId);
        if (!session) {
            // New created session
            createRouter(msWorker)
                .then(router => {
                    console.log('mediasoup Router initialized for session %s', sessionId);
                    sessions.set(sessionId, {
                        router: router,
                        users: [socket.id]
                    });
                    callback({
                        rtpCapabilities: router.rtpCapabilities
                    });
                })
                .catch(error => {
                    console.error('Error initializing mediasoup router for session ' + sessionId, error);
                });
        } else {
            // Add user to existing session
            const session = sessions.get(sessionId);
            session.users.push(socket.id);
            callback({
                rtpCapabilities: session.router.rtpCapabilities
            });
        }
    });


    /**
     * Publish stuff
     */

    socket.on('createProducerTransport', async (data, callback) => {
        const sessionId = data.sessionId;
        const sessionRouter = sessions.get(sessionId).router;
        createWebRtcTransport(sessionRouter)
            .then(transport => {
                console.log('mediasoup WebRtcTransport initialized for user %s in session %s (producer)', socket.id, sessionId);
                finalUsers.get(socket.id).producerTransports.set(transport.id, transport);
                callback({
                    transportOptions: {
                        id: transport.id,
                        iceParameters: transport.iceParameters,
                        iceCandidates: transport.iceCandidates,
                        dtlsParameters: transport.dtlsParameters,
                        sctpParameters: transport.sctpParameters
                    },
                    rtpCapabilities: sessionRouter.rtpCapabilities
                });
            }).catch(error => {
                console.error('Error initializing mediasoup WebRtcTransport for user ' + socket.id + ' in session ' + sessionId + '(producer)', error);
            })
    });

    socket.on('connectProducerTransport', async (data, callback) => {
        let producerTransport = finalUsers.get(socket.id).producerTransports.get(data.transportId);
        producerTransport.connect({
            dtlsParameters: data.dtlsParameters
        });
        callback();
    });

    socket.on('produce', async (data, callback) => {
        let producerTransport = finalUsers.get(socket.id).producerTransports.get(data.transportId);
        producerTransport.produce({
            kind: data.kind,
            rtpParameters: data.rtpParameters
        }).then(producer => {
            console.log('mediasoup Producer initialized for user %s. {kind: %s, type: %s}', socket.id, producer.kind, producer.type);
            finalUsers.get(socket.id).producers.set(producer.id, producer);

            producer.on('transportclose', () => {

            });
            producer.on('score', score => {

            });
            producer.on('videoorientationchange', videoOrientation => {

            });

            callback({
                id: producer.id
            });
            // Broadcast new producer
            socket.broadcast.emit('newProducer');
        }).catch(error => {
            console.error('Error producing', error);
        })
    });

    socket.on('pauseProducer', async (data, callback) => {
        const producer = finalUsers.get(socket.id).producers.get(data.producerId);
        if (producer.paused) {
            return;
        }
        producer.pause();
        callback();
    });

    socket.on('resumeProducer', async (data, callback) => {
        const producer = finalUsers.get(socket.id).producers.get(data.producerId);
        if (!producer.paused) {
            return;
        }
        producer.resume();
        callback();
    });

    socket.on('closeProducer', async (data, callback) => {
        const producer = finalUsers.get(socket.id).producers.get(data.producerId);
        if (producer.closed) {
            return;
        }
        producer.close();
        callback();
    });


    /**
     * Subscribe stuff
     */

    socket.on('createConsumerTransport', async (data, callback) => {
        const sessionId = data.sessionId;
        let sessionRouter = sessions.get(sessionId).router;
        createWebRtcTransport(sessionRouter)
            .then(transport => {
                console.log('mediasoup WebRtcTransport initialized for user %s in session %s (consumer)', socket.id, sessionId);
                finalUsers.get(socket.id).consumerTransports.set(transport.id, transport);
                callback({
                    transportOptions: {
                        id: transport.id,
                        iceParameters: transport.iceParameters,
                        iceCandidates: transport.iceCandidates,
                        dtlsParameters: transport.dtlsParameters,
                        sctpParameters: transport.sctpParameters
                    },
                    rtpCapabilities: sessionRouter.rtpCapabilities
                });
            }).catch(error => {
                console.error('Error initializing mediasoup WebRtcTransport for user ' + socket.id + ' in session ' + sessionId + '(consumer)', error);
            })
    });

    socket.on('connectConsumerTransport', async (data, callback) => {
        let consumerTransport = finalUsers.get(socket.id).consumerTransports.get(data.transportId);
        consumerTransport.connect({
            dtlsParameters: data.dtlsParameters
        });
        callback();
    });

    socket.on('consume', async (data, callback) => {
        const sessionRouter = sessions.get(data.sessionId).router;
        if (!sessionRouter.canConsume({
                producerId: data.producerId,
                rtpCapabilities: data.rtpCapabilities
            })) {
            console.error('Can NOT consume');
            return;
        }
        let consumerTransport = finalUsers.get(socket.id).consumerTransports.get(data.transportId);
        consumerTransport.consume({
            producerId: data.producerId,
            rtpCapabilities: data.rtpCapabilities,
            paused: false
        }).then(consumer => {
            console.log('mediasoup Consumer initialized for user %s for Producer %s. {kind: %s, type: %s}', socket.id, consumer.producerId, consumer.kind, consumer.type);
            finalUsers.get(socket.id).consumers.set(consumer.id, consumer);

            consumer.on('transportclose', () => {

            });
            consumer.on('producerclose', () => {

            });
            consumer.on('producerpause', () => {

            });
            consumer.on('producerresume', () => {

            });
            consumer.on('score', () => {

            });
            consumer.on('layerschange', () => {

            });

            const response = {
                id: consumer.id,
                producerId: consumer.producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
                type: consumer.type,
                paused: consumer.producerPaused
            };

            if (consumer.type === 'simulcast' || consumer.type === 'svc') {
                consumer.setPreferredLayers({
                    spatialLayer: 2,
                    temporalLayer: 2
                }).then(() => {
                    callback(response);
                });
            } else {
                callback(response);
            }
        }).catch(error => {
            console.error('Error consuming', error);
        });
    });

    socket.on('pauseConsumer', async (data, callback, errback) => {
        const consumer = finalUsers.get(socket.id).consumers.get(data.consumerId);
        if (consumer.paused) {
            return;
        }
        consumer.pause();
        callback();
    });

    socket.on('resumeConsumer', async (data, callback) => {
        const consumer = finalUsers.get(socket.id).consumers.get(data.consumerId);
        if (!consumer.paused) {
            return;
        }
        consumer.resume();
        callback();
    });

    socket.on('closeConsumer', async (data, callback) => {
        const consumer = finalUsers.get(socket.id).consumers.get(data.consumerId);
        if (consumer.closed) {
            return;
        }
        consumer.close();
        callback();
    });

    socket.on('publisherStats', async (data, callback) => {
        const producer = finalUsers.get(socket.id).producers.get(data.producerId);
        producer.getStats().then(stats => {
            callback(stats);
        });
    });

    socket.on('subscriberStats', async (data, callback) => {
        const consumer = finalUsers.get(socket.id).consumers.get(data.consumerId);
        consumer.getStats().then(stats => {
            callback(stats);
        });
    });

});

function createWorker() {
    return new Promise((resolve, reject) => {
        MediaSoup.createWorker({
            logLevel: SERVER_CONFIG.mediasoup.worker.logLevel,
            logTags: SERVER_CONFIG.mediasoup.worker.logTags,
            rtcMinPort: SERVER_CONFIG.mediasoup.worker.rtcMinPort,
            rtcMaxPort: SERVER_CONFIG.mediasoup.worker.rtcMaxPort,
        }).then(worker => {
            resolve(worker);
        }).catch(error => {
            reject(error);
        });
    });
}

function createRouter(worker) {
    return new Promise((resolve, reject) => {
        if (!worker) {
            reject(new Error('mediasoup Worker is not initialized'));
        }
        const mediaCodecs = SERVER_CONFIG.mediasoup.router.mediaCodecs;
        worker.createRouter({
                mediaCodecs
            })
            .then(router => {
                resolve(router);
            }).catch(error => {
                reject(error);
            });
    });
}

function createWebRtcTransport(router) {
    return new Promise((resolve, reject) => {
        let webrtcConfig = SERVER_CONFIG.mediasoup.webRtcTransport;
        webrtcConfig['listenIps'] = [{
            ip: Ip.address(),
            announcedIp: null
        }];
        router.createWebRtcTransport(webrtcConfig)
            .then(response => {
                resolve(response);
            }).catch(error => {
                reject(error);
            });
    });
}

function removeFinalUser(userId) {
    // Remove from collection of users
    finalUsers.delete(userId);
    // Remove from any session to which it was connected
    sessions.forEach(session => {
        var index = session.users.indexOf(userId);
        if (index !== -1) {
            session.users.splice(index, 1);
        }
    });
}

createWorker()
    .then(worker => {
        msWorker = worker;
        msWorker.on('died', () => {
            console.error('mediasoup Worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
            setTimeout(() => process.exit(1), 2000);
        });
        console.log('mediasoup worker initialized\n');
    }).catch(error => {
        console.error('Error initializing mediasoup worker');
    });



/**
 * mediasoup Observer API
 */
MediaSoup.observer.on('newworker', (worker) => {
    console.log(Colors.yellow('OBSERVER API: new worker created [worke.pid:%d]'), worker.pid);

    worker.observer.on('close', () => {
        console.log(Colors.yellow('OBSERVER API: worker closed [worker.pid:%d]'), worker.pid);
    });

    worker.observer.on('newrouter', (router) => {
        console.log(
            Colors.yellow('OBSERVER API: new router created [worker.pid:%d, router.id:%s]'),
            worker.pid, router.id);

        router.observer.on('close', () => {
            console.log(Colors.yellow('OBSERVER API: router closed [router.id:%s]'), router.id);
        });

        router.observer.on('newtransport', (transport) => {
            console.log(
                Colors.yellow('OBSERVER API: new transport created [worker.pid:%d, router.id:%s, transport.id:%s]'),
                worker.pid, router.id, transport.id);

            transport.observer.on('close', () => {
                console.log(Colors.yellow('OBSERVER API: transport closed [transport.id:%s]'), transport.id);
            });

            transport.observer.on('newproducer', (producer) => {
                console.log(
                    Colors.yellow('OBSERVER API: new producer created [worker.pid:%d, router.id:%s, transport.id:%s, producer.id:%s]'),
                    worker.pid, router.id, transport.id, producer.id);

                producer.observer.on('close', () => {
                    console.log(Colors.yellow('OBSERVER API: producer closed [producer.id:%s]'), producer.id);
                });
            });

            transport.observer.on('newconsumer', (consumer) => {
                console.log(
                    Colors.yellow('OBSERVER API: new consumer created [worker.pid:%d, router.id:%s, transport.id:%s, consumer.id:%s]'),
                    worker.pid, router.id, transport.id, consumer.id);

                consumer.observer.on('close', () => {
                    console.log(Colors.yellow('OBSERVER API: consumer closed [consumer.id:%s]'), consumer.id);
                });
            });

            transport.observer.on('newdataproducer', (dataProducer) => {
                console.log(
                    Colors.yellow('OBSERVER API: new data producer created [worker.pid:%d, router.id:%s, transport.id:%s, dataProducer.id:%s]'),
                    worker.pid, router.id, transport.id, dataProducer.id);

                dataProducer.observer.on('close', () => {
                    console.log(Colors.yellow('OBSERVER API: data producer closed [dataProducer.id:%s]'), dataProducer.id);
                });
            });

            transport.observer.on('newdataconsumer', (dataConsumer) => {
                console.log(
                    Colors.yellow('OBSERVER API: new data consumer created [worker.pid:%d, router.id:%s, transport.id:%s, dataConsumer.id:%s]'),
                    worker.pid, router.id, transport.id, dataConsumer.id);

                dataConsumer.observer.on('close', () => {
                    console.log(Colors.yellow('OBSERVER API: data consumer closed [dataConsumer.id:%s]'), dataConsumer.id);
                });
            });
        });
    });
});