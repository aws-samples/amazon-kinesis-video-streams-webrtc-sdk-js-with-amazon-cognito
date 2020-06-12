/**
 * This file demonstrates the process of creating a KVS Signaling Channel.
 */

async function createSignalingChannel(formValues) {
    // Create KVS client
    const kinesisVideoClient = new AWS.KinesisVideo({
        region: formValues.region,
        endpoint: formValues.endpoint,
    });

    // Get signaling channel ARN
    await kinesisVideoClient
        .createSignalingChannel({
            ChannelName: formValues.channelName,
        })
        .promise();

    // Get signaling channel ARN
    const describeSignalingChannelResponse = await kinesisVideoClient
        .describeSignalingChannel({
            ChannelName: formValues.channelName,
        })
        .promise();
    const channelARN = describeSignalingChannelResponse.ChannelInfo.ChannelARN;
    console.log('[CREATE_SIGNALING_CHANNEL] Channel ARN: ', channelARN);
}
