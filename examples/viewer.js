/**
 * This file demonstrates the process of starting WebRTC streaming using a KVS Signaling Channel.
 */
const viewer = {};

function getCredential(formValues, callback, err) {
    if (err)
        console.log(err);
    else {
        var authenticationData = {
            Username: formValues.username,
            Password: formValues.password,
        };

        var authenticationDetails = new AmazonCognitoIdentity.AuthenticationDetails(
            authenticationData
        );

        var poolData = {
            UserPoolId: '<User Pool ID>', // Your user pool id here
            ClientId: '<App Client ID>', // Your client id here
        };
        var userPool = new AmazonCognitoIdentity.CognitoUserPool(poolData);

        var userData = {
            Username: formValues.username,
            Pool: userPool,
        };
        var cognitoUser = new AmazonCognitoIdentity.CognitoUser(userData);

        //console.log(AWS.config.credentials.accessKeyId)

        //this is the call where it throws an error in the first run
        cognitoUser.authenticateUser(authenticationDetails, {
            onSuccess: function(result) {
                var accessToken = result.getAccessToken().getJwtToken();

                //POTENTIAL: Region needs to be set if not already set previously elsewhere.
                AWS.config.region = formValues.region;

                AWS.config.credentials = new AWS.CognitoIdentityCredentials({
                    IdentityPoolId: '<Identity Pool ID>', // your identity pool id here
                    Logins: {
                        // Change the key below according to the specific region your user pool is in.
                        'cognito-idp.<region>.amazonaws.com/<User Pool ID>': result
                            .getIdToken()
                            .getJwtToken(),
                    },
                });

                //refreshes credentials using AWS.CognitoIdentity.getCredentialsForIdentity()
                AWS.config.credentials.refresh(error => {
                    if (error) {
                        console.error(error);
                    } else  {
                        // Instantiate aws sdk service objects now that the credentials have been updated.
                        // example: var s3 = new AWS.S3();
                        console.log('Successfully logged!');
                        callback();
                    }
                });
            },
            onFailure: function(err) {
                alert(err.message || JSON.stringify(err));
            },
        });
    }
}

async function postViewerLogin(localView, remoteView, formValues, onStatsReport, onRemoteDataMessage) {
    viewer.localView = localView;
    viewer.remoteView = remoteView;

    // Create KVS client
    const kinesisVideoClient = new AWS.KinesisVideo({
        region: formValues.region,
        endpoint: formValues.endpoint,
        correctClockSkew: true,
    });

    // Get signaling channel ARN
    const describeSignalingChannelResponse = await kinesisVideoClient
        .describeSignalingChannel({
            ChannelName: formValues.channelName,
        })
        .promise();
    const channelARN = describeSignalingChannelResponse.ChannelInfo.ChannelARN;
    console.log('[VIEWER] Channel ARN: ', channelARN);

    // Get signaling channel endpoints
    const getSignalingChannelEndpointResponse = await kinesisVideoClient
        .getSignalingChannelEndpoint({
            ChannelARN: channelARN,
            SingleMasterChannelEndpointConfiguration: {
                Protocols: ['WSS', 'HTTPS'],
                Role: KVSWebRTC.Role.VIEWER,
            },
        })
        .promise();
    const endpointsByProtocol = getSignalingChannelEndpointResponse.ResourceEndpointList.reduce((endpoints, endpoint) => {
        endpoints[endpoint.Protocol] = endpoint.ResourceEndpoint;
        return endpoints;
    }, {});
    console.log('[VIEWER] Endpoints: ', endpointsByProtocol);

    const kinesisVideoSignalingChannelsClient = new AWS.KinesisVideoSignalingChannels({
        region: formValues.region,
        endpoint: endpointsByProtocol.HTTPS,
        correctClockSkew: true,
    });

    // Get ICE server configuration
    const getIceServerConfigResponse = await kinesisVideoSignalingChannelsClient
        .getIceServerConfig({
            ChannelARN: channelARN,
        })
        .promise();
    const iceServers = [];
    if (!formValues.natTraversalDisabled && !formValues.forceTURN) {
        iceServers.push({ urls: `stun:stun.kinesisvideo.${formValues.region}.amazonaws.com:443` });
    }
    if (!formValues.natTraversalDisabled) {
        getIceServerConfigResponse.IceServerList.forEach(iceServer =>
            iceServers.push({
                urls: iceServer.Uris,
                username: iceServer.Username,
                credential: iceServer.Password,
            }),
        );
    }
    console.log('[VIEWER] ICE servers: ', iceServers);

    // Create Signaling Client
    viewer.signalingClient = new KVSWebRTC.SignalingClient({
        channelARN,
        channelEndpoint: endpointsByProtocol.WSS,
        clientId: formValues.clientId,
        role: KVSWebRTC.Role.VIEWER,
        region: formValues.region,
        credentials: {
            accessKeyId: AWS.config.credentials.accessKeyId,
            secretAccessKey: AWS.config.credentials.secretAccessKey,
            sessionToken: AWS.config.credentials.sessionToken,
        },
    });

    const resolution = formValues.widescreen ? { width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 640 }, height: { ideal: 480 } };
    const constraints = {
        video: formValues.sendVideo ? resolution : false,
        audio: formValues.sendAudio,
    };
    const configuration = {
        iceServers,
        iceTransportPolicy: formValues.forceTURN ? 'relay' : 'all',
    };
    viewer.peerConnection = new RTCPeerConnection(configuration);
    if (formValues.openDataChannel) {
        viewer.dataChannel = viewer.peerConnection.createDataChannel('kvsDataChannel');
        viewer.peerConnection.ondatachannel = event => {
            event.channel.onmessage = onRemoteDataMessage;
        };
    }

    // Poll for connection stats
    viewer.peerConnectionStatsInterval = setInterval(() => viewer.peerConnection.getStats().then(onStatsReport), 1000);

    viewer.signalingClient.on('open', async () => {
        console.log('[VIEWER] Connected to signaling service');

        // Get a stream from the webcam, add it to the peer connection, and display it in the local view
        try {
            viewer.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            viewer.localStream.getTracks().forEach(track => viewer.peerConnection.addTrack(track, viewer.localStream));
            localView.srcObject = viewer.localStream;
        } catch (e) {
            console.error('[VIEWER] Could not find webcam');
            return;
        }

        // Create an SDP offer to send to the master
        console.log('[VIEWER] Creating SDP offer');
        await viewer.peerConnection.setLocalDescription(
            await viewer.peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true,
            }),
        );

        // When trickle ICE is enabled, send the offer now and then send ICE candidates as they are generated. Otherwise wait on the ICE candidates.
        if (formValues.useTrickleICE) {
            console.log('[VIEWER] Sending SDP offer');
            viewer.signalingClient.sendSdpOffer(viewer.peerConnection.localDescription);
        }
        console.log('[VIEWER] Generating ICE candidates');
    });

    viewer.signalingClient.on('sdpAnswer', async answer => {
        // Add the SDP answer to the peer connection
        console.log('[VIEWER] Received SDP answer');
        await viewer.peerConnection.setRemoteDescription(answer);
    });

    viewer.signalingClient.on('iceCandidate', candidate => {
        // Add the ICE candidate received from the MASTER to the peer connection
        console.log('[VIEWER] Received ICE candidate');
        viewer.peerConnection.addIceCandidate(candidate);
    });

    viewer.signalingClient.on('close', () => {
        console.log('[VIEWER] Disconnected from signaling channel');
    });

    viewer.signalingClient.on('error', error => {
        console.error('[VIEWER] Signaling client error: ', error);
    });

    // Send any ICE candidates to the other peer
    viewer.peerConnection.addEventListener('icecandidate', ({ candidate }) => {
        if (candidate) {
            console.log('[VIEWER] Generated ICE candidate');

            // When trickle ICE is enabled, send the ICE candidates as they are generated.
            if (formValues.useTrickleICE) {
                console.log('[VIEWER] Sending ICE candidate');
                viewer.signalingClient.sendIceCandidate(candidate);
            }
        } else {
            console.log('[VIEWER] All ICE candidates have been generated');

            // When trickle ICE is disabled, send the offer now that all the ICE candidates have ben generated.
            if (!formValues.useTrickleICE) {
                console.log('[VIEWER] Sending SDP offer');
                viewer.signalingClient.sendSdpOffer(viewer.peerConnection.localDescription);
            }
        }
    });

    // As remote tracks are received, add them to the remote view
    viewer.peerConnection.addEventListener('track', event => {
        console.log('[VIEWER] Received remote track');
        if (remoteView.srcObject) {
            return;
        }
        viewer.remoteStream = event.streams[0];
        remoteView.srcObject = viewer.remoteStream;
    });

    console.log('[VIEWER] Starting viewer connection');
    viewer.signalingClient.open();

}

function startViewer(localView, remoteView, formValues, onStatsReport, onRemoteDataMessage) {
    getCredential(formValues, function(){
        postViewerLogin(localView, remoteView, formValues, onStatsReport, onRemoteDataMessage)
    });
}

function stopViewer() {
    console.log('[VIEWER] Stopping viewer connection');
    if (viewer.signalingClient) {
        viewer.signalingClient.close();
        viewer.signalingClient = null;
    }

    if (viewer.peerConnection) {
        viewer.peerConnection.close();
        viewer.peerConnection = null;
    }

    if (viewer.localStream) {
        viewer.localStream.getTracks().forEach(track => track.stop());
        viewer.localStream = null;
    }

    if (viewer.remoteStream) {
        viewer.remoteStream.getTracks().forEach(track => track.stop());
        viewer.remoteStream = null;
    }

    if (viewer.peerConnectionStatsInterval) {
        clearInterval(viewer.peerConnectionStatsInterval);
        viewer.peerConnectionStatsInterval = null;
    }

    if (viewer.localView) {
        viewer.localView.srcObject = null;
    }

    if (viewer.remoteView) {
        viewer.remoteView.srcObject = null;
    }

    if (viewer.dataChannel) {
        viewer.dataChannel = null;
    }
}

function sendViewerMessage(message) {
    if (viewer.dataChannel) {
        try {
            viewer.dataChannel.send(message);
        } catch (e) {
            console.error('[VIEWER] Send DataChannel: ', e.toString());
        }
    }
}
