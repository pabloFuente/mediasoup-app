const SERVER_CONFIG = require('./config');
const MediasoupClient = require('mediasoup-client');
const SocketClient = require('socket.io-client');
const SocketPromise = require('./lib/socket.io-promise').promise;

let device;
const sessionId = 'TestSession';
const videoProducers = new Map();
const audioProducers = new Map();
const videoConsumers = new Map();
const audioConsumers = new Map();

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
}

function joinSession() {
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

function publish() {
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
            video: true,
            audio: true
        }).then(stream => {
            document.getElementById('local-video').srcObject = stream;

            // Video track
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
                videoProducers.set(producer.id, producer);

                msg = 'Client side: Producer (' + producer.id + ') of kind "' + producer.kind + '" created';
                console.log(msg);
                log(msg);
            }).catch(error => {
                console.error('Error while calling Transport.produce for the video track', error);
            });

            // Audio track
            const audioTrack = stream.getAudioTracks()[0];
            transport.produce({
                track: audioTrack
            }).then(producer => {
                audioProducers.set(producer.id, producer);

                msg = 'Client side: Producer (' + producer.id + ') of kind "' + producer.kind + '" created';
                console.log(msg);
                log(msg);
            }).catch(error => {
                console.error('Error while calling Transport.produce for the video track', error);
            });
        });
    }).catch(error => {
        console.error('Error while creating Producer Transport in server side', error);
    });
}

function subscribe() {
    const videoProducer = videoProducers.values().next().value;
    const audioProducer = audioProducers.values().next().value;

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
            videoProducerId: videoProducer.id,
            audioProducerId: audioProducer.id,
            rtpCapabilities: device.rtpCapabilities,
            transportId: transport.id
        }).then(response => {
            msg = 'Server side: Consumer created (' + response.id + ')';
            console.log(msg);
            log(msg);

            const remoteStream = new MediaStream();

            // Consume video
            transport.consume({
                    id: response.video.id,
                    producerId: response.video.producerId,
                    kind: response.video.kind,
                    rtpParameters: response.video.rtpParameters
                })
                .then(videoConsumer => {
                    videoConsumers.set(videoConsumer.id, videoConsumer);

                    msg = 'Client side: VIDEO Consumer (' + videoConsumer.id + ') of kind "' + videoConsumer.kind + '" associated to ' + videoConsumer.producerId + ' created';
                    console.log(msg);
                    log(msg);

                    remoteStream.addTrack(videoConsumer.track);
                    document.getElementById('remote-video').srcObject = remoteStream;
                }).catch(error => {
                    console.error('Error while calling VIDEO Transport.consume', error);
                });

            // Consume audio
            transport.consume({
                    id: response.audio.id,
                    producerId: response.audio.producerId,
                    kind: response.audio.kind,
                    rtpParameters: response.audio.rtpParameters
                })
                .then(audioConsumer => {
                    audioConsumers.set(audioConsumer.id, audioConsumer);

                    msg = 'Client side: AUDIO Consumer (' + audioConsumer.id + ') of kind "' + audioConsumer.kind + '" associated to ' + audioConsumer.producerId + ' created';
                    console.log(msg);
                    log(msg);

                    remoteStream.addTrack(audioConsumer.track);
                }).catch(error => {
                    console.error('Error while calling AUDIO Transport.consume', error);
                });
        }).catch(error => {
            console.error('Error calling "consume"', error);
        });

    }).catch(error => {
        console.error('Error while creating Consumer Transport in server side', error);
    })
}

function pauseVideoPublisher() {
    const videoProducer = videoProducers.values().next().value;
    socket.request('pauseProducer', {
        producerId: videoProducer.id
    }).then(() => {
        videoProducer.pause();
        const msg = 'VIDEO producer (' + videoProducer.id + ') paused';
        console.log(msg);
        log(msg);
    });
}

function pauseAudioPublisher() {
    const audioProducer = audioProducers.values().next().value;
    socket.request('pauseProducer', {
        producerId: audioProducer.id
    }).then(() => {
        audioProducer.pause();
        const msg = 'AUDIO producer (' + audioProducer.id + ') paused';
        console.log(msg);
        log(msg);
    });
}

function pauseVideoSubscriber() {
    const videoConsumer = videoConsumers.values().next().value;
    socket.request('pauseConsumer', {
        consumerId: videoConsumer.id
    }).then(() => {
        videoConsumer.pause();
        const msg = 'VIDEO consumer (' + videoConsumers.id + ') paused';
        console.log(msg);
        log(msg);
    });
}

function pauseAudioSubscriber() {
    const audioConsumer = audioConsumers.values().next().value;
    socket.request('pauseConsumer', {
        consumerId: audioConsumer.id
    }).then(() => {
        audioConsumer.pause();
        const msg = 'AUDIO consumer (' + audioConsumer.id + ') paused';
        console.log(msg);
        log(msg);
    });
}

function resumeVideoPublisher() {
    const videoProducer = videoProducers.values().next().value;
    socket.request('resumeProducer', {
        producerId: videoProducer.id
    }).then(() => {
        videoProducer.resume();
        const msg = 'VIDEO producer (' + videoProducer.id + ') resumed';
        console.log(msg);
        log(msg);
    });
}

function resumeAudioPublisher() {
    const audioProducer = audioProducers.values().next().value;
    socket.request('resumeProducer', {
        producerId: audioProducer.id
    }).then(() => {
        audioProducer.resume();
        const msg = 'AUDIO producer (' + audioProducer.id + ') resumed';
        console.log(msg);
        log(msg);
    });
}

function resumeVideoSubscriber() {
    const videoConsumer = videoConsumers.values().next().value;
    socket.request('resumeConsumer', {
        consumerId: videoConsumer.id
    }).then(() => {
        videoConsumer.resume();
        const msg = 'VIDEO Consumer (' + videoConsumer.id + ') resumed';
        console.log(msg);
        log(msg);
    });
}

function resumeAudioSubscriber() {
    const audioConsumer = audioConsumers.values().next().value;
    socket.request('resumeConsumer', {
        consumerId: audioConsumer.id
    }).then(() => {
        audioConsumer.resume();
        const msg = 'AUDIO Consumer (' + audioConsumer.id + ') resumed';
        console.log(msg);
        log(msg);
    });
}

function closePublisher() {
    const videoProducer = videoProducers.values().next().value;
    const audioProducer = audioProducers.values().next().value;
    socket.request('closeProducer', {
        producerId: videoProducer.id
    }).then(() => {
        videoProducer.close();
        const msg = 'VIDEO producer (' + videoProducer.id + ') closed';
        console.log(msg);
        log(msg);
    });
    socket.request('closeProducer', {
        producerId: audioProducer.id
    }).then(() => {
        audioProducer.close();
        const msg = 'AUDIO producer (' + audioProducer.id + ') closed';
        console.log(msg);
        log(msg);
    });
}

function closeSubscriber() {
    const videoConsumer = videoConsumers.values().next().value;
    const audioConsumer = audioConsumers.values().next().value;
    socket.request('closeConsumer', {
        consumerId: videoConsumer.id
    }).then(() => {
        videoConsumer.close();
        const msg = 'VIDEO Consumer (' + videoConsumer.id + ') closed';
        console.log(msg);
        log(msg);
    });
    socket.request('closeConsumer', {
        consumerId: audioConsumer.id
    }).then(() => {
        audioConsumer.close();
        const msg = 'AUDIO Consumer (' + audioConsumer.id + ') closed';
        console.log(msg);
        log(msg);
    });
}

function videoPublisherStats() {
    const videoProducer = videoProducers.values().next().value;
    socket.request('publisherStats', {
        producerId: videoProducer.id
    }).then(remoteStats => {
        videoProducer.getStats().then(stats => {
            console.log('Remote stats for VIDEO producer ' + videoProducer.id, remoteStats);
            let localStats = {};
            for (const [key, value] of stats.entries()) {
                localStats[key] = value;
            }
            console.log('Local stats for VIDEO producer ' + videoProducer.id, localStats);
            log('Local and remote stats received for VIDEO producer ' + videoProducer.id + ' (see console)');
        });
    });
}

function audioPublisherStats() {
    const audioProducer = audioProducers.values().next().value;
    socket.request('publisherStats', {
        producerId: audioProducer.id
    }).then(remoteStats => {
        audioProducer.getStats().then(stats => {
            console.log('Remote stats for AUDIO producer ' + audioProducer.id, remoteStats);
            let localStats = {};
            for (const [key, value] of stats.entries()) {
                localStats[key] = value;
            }
            console.log('Local stats for AUDIO producer ' + audioProducer.id, localStats);
            log('Local and remote stats received for AUDIO producer ' + audioProducer.id + ' (see console)');
        });
    });
}

function videoSubscriberStats() {
    const videoConsumer = videoConsumers.values().next().value;
    socket.request('subscriberStats', {
        consumerId: videoConsumer.id
    }).then(remoteStats => {
        videoConsumer.getStats().then(stats => {
            console.log('Remote stats for VIDEO consumer ' + videoConsumer.id, remoteStats);
            let localStats = {};
            for (const [key, value] of stats.entries()) {
                localStats[key] = value;
            }
            console.log('Local stats for VIDEO consumer ' + videoConsumer.id, localStats);
            log('Local and remote stats received for VIDEO consumer ' + videoConsumer.id + ' (see console)');
        });
    });
}

function audioSubscriberStats() {
    const audioConsumer = audioConsumers.values().next().value;
    socket.request('subscriberStats', {
        consumerId: audioConsumer.id
    }).then(remoteStats => {
        audioConsumer.getStats().then(stats => {
            console.log('Remote stats for AUDIO consumer ' + audioConsumer.id, remoteStats);
            let localStats = {};
            for (const [key, value] of stats.entries()) {
                localStats[key] = value;
            }
            console.log('Local stats for AUDIO consumer ' + audioConsumer.id, localStats);
            log('Local and remote stats received for AUDIO consumer ' + audioConsumer.id + ' (see console)');
        });
    });
}

function recordAudio() {
    const audioProducer = audioProducers.values().next().value;
    socket.request('record', {
        sessionId,
        audioProducerId: audioProducer.id,
        hasAudio: true,
        hasVideo: false
    }).then(() => {
        console.log('Recording started');
    });
}

function recordVideo() {
    const videoProducer = videoProducers.values().next().value;
    socket.request('record', {
        sessionId,
        videoProducerId: videoProducer.id,
        hasAudio: false,
        hasVideo: true
    }).then(() => {
        console.log('Recording started');
    });
}

function recordAudioVideo() {
    const audioProducer = audioProducers.values().next().value;
    const videoProducer = audioProducers.values().next().value;
    socket.request('record', {
        sessionId,
        videoProducerId: videoProducer.id,
        audioProducerId: audioProducer.id,
        hasAudio: true,
        hasVideo: true
    }).then(() => {
        console.log('Recording started');
    });
}

function stopRecord() {
    socket.request('stopRecord', {
        sessionId
    }).then(() => {
        console.log('Recoding stopped');
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
    publish,
    subscribe,
    pauseVideoPublisher,
    pauseAudioPublisher,
    pauseVideoSubscriber,
    pauseAudioSubscriber,
    resumeVideoPublisher,
    resumeAudioPublisher,
    resumeVideoSubscriber,
    resumeAudioSubscriber,
    closePublisher,
    closeSubscriber,
    videoPublisherStats,
    audioPublisherStats,
    videoSubscriberStats,
    audioSubscriberStats,
    recordAudio,
    recordVideo,
    recordAudioVideo,
    stopRecord
};