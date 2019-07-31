const Ip = require('ip');
console.log('Internal IP is %s', Ip.address());

module.exports = {
    ip: '0.0.0.0',
    internalIp: Ip.address(),
    port: 8080,
    path: '/server',
    ws: {
        pingInterval: 25000,
        pingTimeout: 5000
    },
    mediasoup: {
        worker: {
            logLevel: 'warn',
            logTags: [
                'info',
                'ice',
                'dtls',
                'rtp',
                'srtp',
                'rtcp',
                // 'rtx',
                // 'bwe',
                // 'score',
                // 'simulcast',
                // 'svc'
            ],
            rtcMinPort: 32256,
            rtcMaxPort: 65535
        },
        router: {
            mediaCodecs: [{
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    preferredPayloadType: 109,
                    channels: 2
                },
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000,
                    preferredPayloadType: 120,
                    parameters: {
                        'x-google-start-bitrate': 1000
                    }
                }
            ]
        },
        webRtcTransport: {
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            minimumAvailableOutgoingBitrate: 300000,
            initialAvailableOutgoingBitrate: 600000
        },
        plainRtpTransport: {
            listenIp: {
                ip: Ip.address(),
                announcedIp: null
            },
            maxSctpMessageSize: 262144
        }
    }
}