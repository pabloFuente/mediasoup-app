const SERVER_CONFIG = require('./config');
const MediasoupClient = require('mediasoup-client');
const SocketClient = require('socket.io-client');
const SocketPromise = require('./lib/socket.io-promise').promise;

let device;
const producers = new Map();
const consumers = new Map();

function connectWebSocket() {

    const opts = {
        path: SERVER_CONFIG.path,
        transports: ['websocket']
    };

    const serverUrl = 'https://' + SERVER_CONFIG.ip + ':' + SERVER_CONFIG.port;
    socket = SocketClient(serverUrl, opts);
    socket.request = SocketPromise(socket);

    socket.on('connect', () => {
        const msg = 'WebSocket connected';
        console.log(msg);
        log(msg);
    });

    socket.on('connecting', () => {
        const msg = 'WebSocket connecting';
        console.log(msg);
        log(msg);
    });

    socket.on('connect_error', error => {
        const msg = 'WebSocket connect error: ' + error;
        console.error(msg);
        log(msg);
    });

    socket.on('connect_timeout', () => {
        const msg = 'WebSocket connect timeout';
        console.error(msg);
        log(msg);
    });

    socket.on('disconnect', reason => {
        const msg = 'WebSocket disconnect: ' + reason;
        console.warn(msg);
        log(msg);
        if (reason === 'io server disconnect') {
            // The disconnection was initiated by the server, you need to reconnect manually
            socket.connect();
        }
    });

    socket.on('error', error => {
        console.error('WebSocket error', error);
    });

    socket.on('reconnecting', () => {
        const msg = 'WebSocket reconnecting';
        console.log(msg);
        log(msg);
    });

    socket.on('reconnect', attemptNumber => {
        const msg = 'WebSocket reconnected. Attempt ' + attemptNumber;
        console.log(msg);
        log(msg);
    });

    socket.on('reconnect_attempt', attemptNumber => {
        const msg = 'WebSocket trying to reconnect (attempt ' + attemptNumber + ')'
        console.log(msg);
        log(msg);
    });

    socket.on('reconnect_error', error => {
        console.error('WebSocket reconnect error', error);
    });

    socket.on('reconnect_failed', () => {
        const msg = 'WebSocket reconnect failed';
        console.error(msg);
        log(msg);
    });

    socket.on('ping', () => {
        console.log('ping');
    });

    socket.on('pong', latency => {
        console.log('pong (' + latency + ' ms of latency)');
    });

    /*ws.onmessage = data => {
        let message = JSON.parse(data.data);
        handleMessage(message);
    }*/
}

function joinSession() {
    let sessionId = 'TestSession';
    socket.request('joinRoom', {
        sessionId
    }).then(response => {
        let msg = 'Joined to session ' + sessionId;
        console.log(msg);
        console.log('Session ' + sessionId + ' is associated to mediasoup Router with codecs', response.rtpCapabilities);
        log(msg + '. Associated mediasoup Router with codecs ' + JSON.stringify(response.rtpCapabilities.codecs.map(codec => codec.mimeType)));

        try {
            device = new MediasoupClient.Device();
        } catch (error) {
            if (error.name === 'UnsupportedError')
                console.error('browser not supported');
        }
        device.load({
                routerRtpCapabilities: response.rtpCapabilities
            })
            .then(() => {
                let canProduce = [];
                if (device.canProduce('audio')) {
                    canProduce.push('audio');
                }
                if (device.canProduce('video')) {
                    canProduce.push('video');
                }
                msg = 'Client side: device successfully loaded for client ' + device.handlerName + '. Can produce ' + JSON.stringify(canProduce) +
                    '. Support for codecs ' + JSON.stringify(device.rtpCapabilities.codecs.map(codec => codec.mimeType));
                console.log(msg);
                log(msg);
            }).catch(error => {
                console.error('Error while loading Device', error);
            });

    }).catch(error => {
        console.error('Error joining session ' + sessionId, error);
    })
}

function publishVideo() {
    const sessionId = 'TestSession';
    socket.request('createProducerTransport', {
        sessionId
    }).then(response => {
        let msg = 'Server side: WebRtc Transport created (' + response.transportOptions.id + ')';
        console.log(msg);
        log(msg);

        const transport = device.createSendTransport(response.transportOptions);
        msg = 'Client side: WebRtc Transport created (' + transport.id + ') with direction "' + transport.direction + '"';
        console.log(msg);
        log(msg);

        transport.on('connect', async ({
            dtlsParameters
        }, callback, errback) => {
            msg = 'Client side: Transport (' + transport.id + ') triggered event "connect"';
            console.log(msg);
            log(msg);

            socket.request('connectProducerTransport', {
                dtlsParameters,
                transportId: transport.id
            }).then(() => {
                msg = 'Server side: Transport (' + transport.id + ') is now connected';
                console.log(msg);
                log(msg);
                callback();
            }).catch(error => {
                errback(error);
            });
        });

        transport.on('produce', async ({
            kind,
            rtpParameters
        }, callback, errback) => {
            msg = 'Client side: Transport (' + transport.id + ') triggered event "produce"';
            console.log(msg);
            log(msg);

            socket.request('produce', {
                transportId: transport.id,
                kind,
                rtpParameters,
            }).then(response => {
                msg = 'Server side: Producer created (' + response.id + ')';
                console.log(msg);
                log(msg);

                callback({
                    id: response.id
                });
            }).catch(error => {
                errback(error);
            });
        });

        transport.on('connectionstatechange', state => {
            msg = 'Client side: Transport (' + transport.id + ') triggered "connectionstatechange" (' + state + ')';
            console.log(msg);
            log(msg);

            switch (state) {
                case 'new':
                    break;
                case 'connecting':
                    break;
                case 'connected':
                    break;
                case 'disconnected':
                    break;
                case 'failed':
                    break;
                case 'closed':
                    break;
                default:
                    break;
            }
        });

        // Send webcam video with 3 simulcast streams.
        navigator.mediaDevices.getUserMedia({
            video: true
        }).then(stream => {
            document.getElementById('local-video').srcObject = stream;
            const videoTrack = stream.getVideoTracks()[0];
            transport.produce({
                track: videoTrack,
                encodings: [{
                        maxBitrate: 100000
                    },
                    {
                        maxBitrate: 300000
                    },
                    {
                        maxBitrate: 900000
                    }
                ],
                codecOptions: {
                    videoGoogleStartBitrate: 1000
                }
            }).then(producer => {
                producers.set(producer.id, producer);

                msg = 'Client side: Producer (' + producer.id + ') of kind "' + producer.kind + '" created';
                console.log(msg);
                log(msg);
            }).catch(error => {
                console.error('Error while calling Transport.produce', error);
            });
        });
    }).catch(error => {
        console.error('Error while creating Producer Transport in server side', error);
    });
}

function subscribeVideo() {
    const sessionId = 'TestSession';
    const producer = producers.values().next().value;

    socket.request('createConsumerTransport', {
        sessionId
    }).then(response => {
        let msg = 'Server side: WebRtc Transport created (' + response.transportOptions.id + ')';
        console.log(msg);
        log(msg);

        const transport = device.createRecvTransport(response.transportOptions);

        msg = 'Client side: WebRtc Transport created (' + transport.id + ') with direction "' + transport.direction + '"';
        console.log(msg);
        log(msg);

        console.log();

        transport.on('connect', async ({
            dtlsParameters
        }, callback, errback) => {

            msg = 'Client side: Transport (' + transport.id + ') triggered event "connect"';
            console.log(msg);
            log(msg);

            socket.request('connectConsumerTransport', {
                dtlsParameters,
                transportId: transport.id
            }).then(() => {
                msg = 'Server side: Transport (' + transport.id + ') is now connected';
                console.log(msg);
                log(msg);
                callback();
            }).catch(error => {
                errback(error);
            })
        });

        transport.on('connectionstatechange', state => {
            msg = 'Client side: Transport (' + transport.id + ') triggered "connectionstatechange" (' + state + ')';
            console.log(msg);
            log(msg);

            switch (state) {
                case 'new':
                    break;
                case 'connecting':
                    break;
                case 'connected':
                    break;
                case 'disconnected':
                    break;
                case 'failed':
                    break;
                case 'closed':
                    break;
                default:
                    break;
            }
        });

        socket.request('consume', {
            sessionId: sessionId,
            producerId: producer.id,
            rtpCapabilities: device.rtpCapabilities,
            transportId: transport.id
        }).then(response => {
            msg = 'Server side: Consumer created (' + response.id + ')';
            console.log(msg);
            log(msg);

            transport.consume({
                    id: response.id,
                    producerId: response.producerId,
                    kind: response.kind,
                    rtpParameters: response.rtpParameters
                })
                .then(consumer => {
                    consumers.set(consumer.id, consumer);

                    msg = 'Client side: Consumer (' + consumer.id + ') of kind "' + consumer.kind + '" associated to ' + consumer.producerId + ' created';
                    console.log(msg);
                    log(msg);

                    const remoteStream = new MediaStream();
                    remoteStream.addTrack(consumer.track);
                    document.getElementById('remote-video').srcObject = remoteStream;
                }).catch(error => {
                    console.error('Error while calling Transport.consume', error);
                });
        }).catch(error => {
            console.error('Error calling "consume"', error);
        });

    }).catch(error => {
        console.error('Error while creating Consumer Transport in server side', error);
    })
}

function pausePublisher() {
    const producer = producers.values().next().value;
    socket.request('pauseProducer', {
        producerId: producer.id
    }).then(() => {
        producer.pause();
        const msg = 'Producer (' + producer.id + ') paused';
        console.log(msg);
        log(msg);
    });
}

function pauseSubscriber() {
    const consumer = consumers.values().next().value;
    socket.request('pauseConsumer', {
        consumerId: consumer.id
    }).then(() => {
        consumer.pause();
        const msg = 'Consumer (' + consumer.id + ') paused';
        console.log(msg);
        log(msg);
    });
}

function resumePublisher() {
    const producer = producers.values().next().value;
    socket.request('resumeProducer', {
        producerId: producer.id
    }).then(() => {
        producer.resume();
        const msg = 'Producer (' + producer.id + ') resumed';
        console.log(msg);
        log(msg);
    });
}

function resumeSubscriber() {
    const consumer = consumers.values().next().value;
    socket.request('resumeConsumer', {
        consumerId: consumer.id
    }).then(() => {
        consumer.resume();
        const msg = 'Consumer (' + consumer.id + ') resumed';
        console.log(msg);
        log(msg);
    });
}

function closePublisher() {
    const producer = producers.values().next().value;
    socket.request('closeProducer', {
        producerId: producer.id
    }).then(() => {
        producer.close();
        const msg = 'Producer (' + producer.id + ') closed';
        console.log(msg);
        log(msg);
    });
}

function closeSubscriber() {
    const consumer = consumers.values().next().value;
    socket.request('closeConsumer', {
        consumerId: consumer.id
    }).then(() => {
        consumer.close();
        const msg = 'Consumer (' + consumer.id + ') closed';
        console.log(msg);
        log(msg);
    });
}

function publisherStats() {
    const producer = producers.values().next().value;
    socket.request('publisherStats', {
        producerId: producer.id
    }).then(remoteStats => {
        producer.getStats().then(stats => {
            console.log('Remote stats for producer ' + producer.id, remoteStats);
            let localStats = {};
            for (const [key, value] of stats.entries()) {
                localStats[key] = value;
            }
            console.log('Local stats for producer ' + producer.id, localStats);
            log('Local and remote stats received for producer ' + producer.id + ' (see console)');
        });
    });
}

function subscriberStats() {
    const consumer = consumers.values().next().value;
    socket.request('subscriberStats', {
        consumerId: consumer.id
    }).then(remoteStats => {
        consumer.getStats().then(stats => {
            console.log('Remote stats for consumer ' + consumer.id, remoteStats);
            let localStats = {};
            for (const [key, value] of stats.entries()) {
                localStats[key] = value;
            }
            console.log('Local stats for consumer ' + consumer.id, localStats);
            log('Local and remote stats received for consumer ' + consumer.id + ' (see console)');
        });
    });
}


function log(text) {
    const previousLog = document.getElementById('textarea').value;
    const newLog = previousLog + text + '\n';
    document.getElementById('textarea').value = newLog;
}

module.exports = {
    connectWebSocket,
    joinSession,
    publishVideo,
    subscribeVideo,
    pausePublisher,
    pauseSubscriber,
    resumePublisher,
    resumeSubscriber,
    closePublisher,
    closeSubscriber,
    publisherStats,
    subscriberStats
};