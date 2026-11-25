package io.github.mrciller.cillhub.data

/**
 * Whether a MESSAGE_ACK event represents the current user's own read state.
 * An ack without `user_id` is always ours; one naming a `user_id` is ours only when our own id is
 * known and matches it (older servers also sent MESSAGE_ACK with the partner's user_id on DM reads).
 */
fun isOwnMessageAck(ackUserId: String?, myUserId: String?): Boolean =
    ackUserId.isNullOrEmpty() || (!myUserId.isNullOrEmpty() && ackUserId == myUserId)
