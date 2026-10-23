// Code generated from confluent-kafka-go v2.16.0 generated_errors.go and librdkafka 2.16.0 rdkafka.h; DO NOT EDIT.

package kafka

import "fmt"

// ErrorCode is the integer representation of local and broker error codes
type ErrorCode int

// String returns a human readable representation of an error code
func (c ErrorCode) String() string {
	if s, ok := errorStrings[c]; ok {
		return s
	}
	return fmt.Sprintf("Err-%d?", int(c))
}

const (
	// ErrBadMsg Local: Bad message format
	ErrBadMsg ErrorCode = -199
	// ErrBadCompression Local: Invalid compressed data
	ErrBadCompression ErrorCode = -198
	// ErrDestroy Local: Broker handle destroyed for termination
	ErrDestroy ErrorCode = -197
	// ErrFail Local: Communication failure with broker
	ErrFail ErrorCode = -196
	// ErrTransport Local: Broker transport failure
	ErrTransport ErrorCode = -195
	// ErrCritSysResource Local: Critical system resource failure
	ErrCritSysResource ErrorCode = -194
	// ErrResolve Local: Host resolution failure
	ErrResolve ErrorCode = -193
	// ErrMsgTimedOut Local: Message timed out
	ErrMsgTimedOut ErrorCode = -192
	// ErrPartitionEOF Broker: No more messages
	ErrPartitionEOF ErrorCode = -191
	// ErrUnknownPartition Local: Unknown partition
	ErrUnknownPartition ErrorCode = -190
	// ErrFs Local: File or filesystem error
	ErrFs ErrorCode = -189
	// ErrUnknownTopic Local: Unknown topic
	ErrUnknownTopic ErrorCode = -188
	// ErrAllBrokersDown Local: All broker connections are down
	ErrAllBrokersDown ErrorCode = -187
	// ErrInvalidArg Local: Invalid argument or configuration
	ErrInvalidArg ErrorCode = -186
	// ErrTimedOut Local: Timed out
	ErrTimedOut ErrorCode = -185
	// ErrQueueFull Local: Queue full
	ErrQueueFull ErrorCode = -184
	// ErrIsrInsuff Local: ISR count insufficient
	ErrIsrInsuff ErrorCode = -183
	// ErrNodeUpdate Local: Broker node update
	ErrNodeUpdate ErrorCode = -182
	// ErrSsl Local: SSL error
	ErrSsl ErrorCode = -181
	// ErrWaitCoord Local: Waiting for coordinator
	ErrWaitCoord ErrorCode = -180
	// ErrUnknownGroup Local: Unknown group
	ErrUnknownGroup ErrorCode = -179
	// ErrInProgress Local: Operation in progress
	ErrInProgress ErrorCode = -178
	// ErrPrevInProgress Local: Previous operation in progress
	ErrPrevInProgress ErrorCode = -177
	// ErrExistingSubscription Local: Existing subscription
	ErrExistingSubscription ErrorCode = -176
	// ErrAssignPartitions Local: Assign partitions
	ErrAssignPartitions ErrorCode = -175
	// ErrRevokePartitions Local: Revoke partitions
	ErrRevokePartitions ErrorCode = -174
	// ErrConflict Local: Conflicting use
	ErrConflict ErrorCode = -173
	// ErrState Local: Erroneous state
	ErrState ErrorCode = -172
	// ErrUnknownProtocol Local: Unknown protocol
	ErrUnknownProtocol ErrorCode = -171
	// ErrNotImplemented Local: Not implemented
	ErrNotImplemented ErrorCode = -170
	// ErrAuthentication Local: Authentication failure
	ErrAuthentication ErrorCode = -169
	// ErrNoOffset Local: No offset stored
	ErrNoOffset ErrorCode = -168
	// ErrOutdated Local: Outdated
	ErrOutdated ErrorCode = -167
	// ErrTimedOutQueue Local: Timed out in queue
	ErrTimedOutQueue ErrorCode = -166
	// ErrUnsupportedFeature Local: Required feature not supported by broker
	ErrUnsupportedFeature ErrorCode = -165
	// ErrWaitCache Local: Awaiting cache update
	ErrWaitCache ErrorCode = -164
	// ErrIntr Local: Operation interrupted
	ErrIntr ErrorCode = -163
	// ErrKeySerialization Local: Key serialization error
	ErrKeySerialization ErrorCode = -162
	// ErrValueSerialization Local: Value serialization error
	ErrValueSerialization ErrorCode = -161
	// ErrKeyDeserialization Local: Key deserialization error
	ErrKeyDeserialization ErrorCode = -160
	// ErrValueDeserialization Local: Value deserialization error
	ErrValueDeserialization ErrorCode = -159
	// ErrPartial Local: Partial response
	ErrPartial ErrorCode = -158
	// ErrReadOnly Local: Read-only object
	ErrReadOnly ErrorCode = -157
	// ErrNoent Local: No such entry
	ErrNoent ErrorCode = -156
	// ErrUnderflow Local: Read underflow
	ErrUnderflow ErrorCode = -155
	// ErrInvalidType Local: Invalid type
	ErrInvalidType ErrorCode = -154
	// ErrRetry Local: Retry operation
	ErrRetry ErrorCode = -153
	// ErrPurgeQueue Local: Purged in queue
	ErrPurgeQueue ErrorCode = -152
	// ErrPurgeInflight Local: Purged in flight
	ErrPurgeInflight ErrorCode = -151
	// ErrFatal Local: Fatal error
	ErrFatal ErrorCode = -150
	// ErrInconsistent Local: Inconsistent state
	ErrInconsistent ErrorCode = -149
	// ErrGaplessGuarantee Local: Gap-less ordering would not be guaranteed if proceeding
	ErrGaplessGuarantee ErrorCode = -148
	// ErrMaxPollExceeded Local: Maximum application poll interval (max.poll.interval.ms) exceeded
	ErrMaxPollExceeded ErrorCode = -147
	// ErrUnknownBroker Local: Unknown broker
	ErrUnknownBroker ErrorCode = -146
	// ErrNotConfigured Local: Functionality not configured
	ErrNotConfigured ErrorCode = -145
	// ErrFenced Local: This instance has been fenced by a newer instance
	ErrFenced ErrorCode = -144
	// ErrApplication Local: Application generated error
	ErrApplication ErrorCode = -143
	// ErrAssignmentLost Local: Group partition assignment lost
	ErrAssignmentLost ErrorCode = -142
	// ErrNoop Local: No operation performed
	ErrNoop ErrorCode = -141
	// ErrAutoOffsetReset Local: No offset to automatically reset to
	ErrAutoOffsetReset ErrorCode = -140
	// ErrLogTruncation Local: Partition log truncation detected
	ErrLogTruncation ErrorCode = -139
	// ErrInvalidDifferentRecord Local: an invalid record in the same batch caused the failure of this message too
	ErrInvalidDifferentRecord ErrorCode = -138
	// ErrDestroyBroker Local: Broker handle destroyed without termination
	ErrDestroyBroker ErrorCode = -137
	// ErrUnknown Unknown broker error
	ErrUnknown ErrorCode = -1
	// ErrNoError Success
	ErrNoError ErrorCode = 0
	// ErrOffsetOutOfRange Broker: Offset out of range
	ErrOffsetOutOfRange ErrorCode = 1
	// ErrInvalidMsg Broker: Invalid message
	ErrInvalidMsg ErrorCode = 2
	// ErrUnknownTopicOrPart Broker: Unknown topic or partition
	ErrUnknownTopicOrPart ErrorCode = 3
	// ErrInvalidMsgSize Broker: Invalid message size
	ErrInvalidMsgSize ErrorCode = 4
	// ErrLeaderNotAvailable Broker: Leader not available
	ErrLeaderNotAvailable ErrorCode = 5
	// ErrNotLeaderForPartition Broker: Not leader for partition
	ErrNotLeaderForPartition ErrorCode = 6
	// ErrRequestTimedOut Broker: Request timed out
	ErrRequestTimedOut ErrorCode = 7
	// ErrBrokerNotAvailable Broker: Broker not available
	ErrBrokerNotAvailable ErrorCode = 8
	// ErrReplicaNotAvailable Broker: Replica not available
	ErrReplicaNotAvailable ErrorCode = 9
	// ErrMsgSizeTooLarge Broker: Message size too large
	ErrMsgSizeTooLarge ErrorCode = 10
	// ErrStaleCtrlEpoch Broker: StaleControllerEpochCode
	ErrStaleCtrlEpoch ErrorCode = 11
	// ErrOffsetMetadataTooLarge Broker: Offset metadata string too large
	ErrOffsetMetadataTooLarge ErrorCode = 12
	// ErrNetworkException Broker: Broker disconnected before response received
	ErrNetworkException ErrorCode = 13
	// ErrCoordinatorLoadInProgress Broker: Coordinator load in progress
	ErrCoordinatorLoadInProgress ErrorCode = 14
	// ErrCoordinatorNotAvailable Broker: Coordinator not available
	ErrCoordinatorNotAvailable ErrorCode = 15
	// ErrNotCoordinator Broker: Not coordinator
	ErrNotCoordinator ErrorCode = 16
	// ErrTopicException Broker: Invalid topic
	ErrTopicException ErrorCode = 17
	// ErrRecordListTooLarge Broker: Message batch larger than configured server segment size
	ErrRecordListTooLarge ErrorCode = 18
	// ErrNotEnoughReplicas Broker: Not enough in-sync replicas
	ErrNotEnoughReplicas ErrorCode = 19
	// ErrNotEnoughReplicasAfterAppend Broker: Message(s) written to insufficient number of in-sync replicas
	ErrNotEnoughReplicasAfterAppend ErrorCode = 20
	// ErrInvalidRequiredAcks Broker: Invalid required acks value
	ErrInvalidRequiredAcks ErrorCode = 21
	// ErrIllegalGeneration Broker: Specified group generation id is not valid
	ErrIllegalGeneration ErrorCode = 22
	// ErrInconsistentGroupProtocol Broker: Inconsistent group protocol
	ErrInconsistentGroupProtocol ErrorCode = 23
	// ErrInvalidGroupID Broker: Invalid group.id
	ErrInvalidGroupID ErrorCode = 24
	// ErrUnknownMemberID Broker: Unknown member
	ErrUnknownMemberID ErrorCode = 25
	// ErrInvalidSessionTimeout Broker: Invalid session timeout
	ErrInvalidSessionTimeout ErrorCode = 26
	// ErrRebalanceInProgress Broker: Group rebalance in progress
	ErrRebalanceInProgress ErrorCode = 27
	// ErrInvalidCommitOffsetSize Broker: Commit offset data size is not valid
	ErrInvalidCommitOffsetSize ErrorCode = 28
	// ErrTopicAuthorizationFailed Broker: Topic authorization failed
	ErrTopicAuthorizationFailed ErrorCode = 29
	// ErrGroupAuthorizationFailed Broker: Group authorization failed
	ErrGroupAuthorizationFailed ErrorCode = 30
	// ErrClusterAuthorizationFailed Broker: Cluster authorization failed
	ErrClusterAuthorizationFailed ErrorCode = 31
	// ErrInvalidTimestamp Broker: Invalid timestamp
	ErrInvalidTimestamp ErrorCode = 32
	// ErrUnsupportedSaslMechanism Broker: Unsupported SASL mechanism
	ErrUnsupportedSaslMechanism ErrorCode = 33
	// ErrIllegalSaslState Broker: Request not valid in current SASL state
	ErrIllegalSaslState ErrorCode = 34
	// ErrUnsupportedVersion Broker: API version not supported
	ErrUnsupportedVersion ErrorCode = 35
	// ErrTopicAlreadyExists Broker: Topic already exists
	ErrTopicAlreadyExists ErrorCode = 36
	// ErrInvalidPartitions Broker: Invalid number of partitions
	ErrInvalidPartitions ErrorCode = 37
	// ErrInvalidReplicationFactor Broker: Invalid replication factor
	ErrInvalidReplicationFactor ErrorCode = 38
	// ErrInvalidReplicaAssignment Broker: Invalid replica assignment
	ErrInvalidReplicaAssignment ErrorCode = 39
	// ErrInvalidConfig Broker: Configuration is invalid
	ErrInvalidConfig ErrorCode = 40
	// ErrNotController Broker: Not controller for cluster
	ErrNotController ErrorCode = 41
	// ErrInvalidRequest Broker: Invalid request
	ErrInvalidRequest ErrorCode = 42
	// ErrUnsupportedForMessageFormat Broker: Message format on broker does not support request
	ErrUnsupportedForMessageFormat ErrorCode = 43
	// ErrPolicyViolation Broker: Policy violation
	ErrPolicyViolation ErrorCode = 44
	// ErrOutOfOrderSequenceNumber Broker: Broker received an out of order sequence number
	ErrOutOfOrderSequenceNumber ErrorCode = 45
	// ErrDuplicateSequenceNumber Broker: Broker received a duplicate sequence number
	ErrDuplicateSequenceNumber ErrorCode = 46
	// ErrInvalidProducerEpoch Broker: Producer attempted an operation with an old epoch
	ErrInvalidProducerEpoch ErrorCode = 47
	// ErrInvalidTxnState Broker: Producer attempted a transactional operation in an invalid state
	ErrInvalidTxnState ErrorCode = 48
	// ErrInvalidProducerIDMapping Broker: Producer attempted to use a producer id which is not currently assigned to its transactional id
	ErrInvalidProducerIDMapping ErrorCode = 49
	// ErrInvalidTransactionTimeout Broker: Transaction timeout is larger than the maximum value allowed by the broker's max.transaction.timeout.ms
	ErrInvalidTransactionTimeout ErrorCode = 50
	// ErrConcurrentTransactions Broker: Producer attempted to update a transaction while another concurrent operation on the same transaction was ongoing
	ErrConcurrentTransactions ErrorCode = 51
	// ErrTransactionCoordinatorFenced Broker: Indicates that the transaction coordinator sending a WriteTxnMarker is no longer the current coordinator for a given producer
	ErrTransactionCoordinatorFenced ErrorCode = 52
	// ErrTransactionalIDAuthorizationFailed Broker: Transactional Id authorization failed
	ErrTransactionalIDAuthorizationFailed ErrorCode = 53
	// ErrSecurityDisabled Broker: Security features are disabled
	ErrSecurityDisabled ErrorCode = 54
	// ErrOperationNotAttempted Broker: Operation not attempted
	ErrOperationNotAttempted ErrorCode = 55
	// ErrKafkaStorageError Broker: Disk error when trying to access log file on disk
	ErrKafkaStorageError ErrorCode = 56
	// ErrLogDirNotFound Broker: The user-specified log directory is not found in the broker config
	ErrLogDirNotFound ErrorCode = 57
	// ErrSaslAuthenticationFailed Broker: SASL Authentication failed
	ErrSaslAuthenticationFailed ErrorCode = 58
	// ErrUnknownProducerID Broker: Unknown Producer Id
	ErrUnknownProducerID ErrorCode = 59
	// ErrReassignmentInProgress Broker: Partition reassignment is in progress
	ErrReassignmentInProgress ErrorCode = 60
	// ErrDelegationTokenAuthDisabled Broker: Delegation Token feature is not enabled
	ErrDelegationTokenAuthDisabled ErrorCode = 61
	// ErrDelegationTokenNotFound Broker: Delegation Token is not found on server
	ErrDelegationTokenNotFound ErrorCode = 62
	// ErrDelegationTokenOwnerMismatch Broker: Specified Principal is not valid Owner/Renewer
	ErrDelegationTokenOwnerMismatch ErrorCode = 63
	// ErrDelegationTokenRequestNotAllowed Broker: Delegation Token requests are not allowed on this connection
	ErrDelegationTokenRequestNotAllowed ErrorCode = 64
	// ErrDelegationTokenAuthorizationFailed Broker: Delegation Token authorization failed
	ErrDelegationTokenAuthorizationFailed ErrorCode = 65
	// ErrDelegationTokenExpired Broker: Delegation Token is expired
	ErrDelegationTokenExpired ErrorCode = 66
	// ErrInvalidPrincipalType Broker: Supplied principalType is not supported
	ErrInvalidPrincipalType ErrorCode = 67
	// ErrNonEmptyGroup Broker: The group is not empty
	ErrNonEmptyGroup ErrorCode = 68
	// ErrGroupIDNotFound Broker: The group id does not exist
	ErrGroupIDNotFound ErrorCode = 69
	// ErrFetchSessionIDNotFound Broker: The fetch session ID was not found
	ErrFetchSessionIDNotFound ErrorCode = 70
	// ErrInvalidFetchSessionEpoch Broker: The fetch session epoch is invalid
	ErrInvalidFetchSessionEpoch ErrorCode = 71
	// ErrListenerNotFound Broker: No matching listener
	ErrListenerNotFound ErrorCode = 72
	// ErrTopicDeletionDisabled Broker: Topic deletion is disabled
	ErrTopicDeletionDisabled ErrorCode = 73
	// ErrFencedLeaderEpoch Broker: Leader epoch is older than broker epoch
	ErrFencedLeaderEpoch ErrorCode = 74
	// ErrUnknownLeaderEpoch Broker: Leader epoch is newer than broker epoch
	ErrUnknownLeaderEpoch ErrorCode = 75
	// ErrUnsupportedCompressionType Broker: Unsupported compression type
	ErrUnsupportedCompressionType ErrorCode = 76
	// ErrStaleBrokerEpoch Broker: Broker epoch has changed
	ErrStaleBrokerEpoch ErrorCode = 77
	// ErrOffsetNotAvailable Broker: Leader high watermark is not caught up
	ErrOffsetNotAvailable ErrorCode = 78
	// ErrMemberIDRequired Broker: Group member needs a valid member ID
	ErrMemberIDRequired ErrorCode = 79
	// ErrPreferredLeaderNotAvailable Broker: Preferred leader was not available
	ErrPreferredLeaderNotAvailable ErrorCode = 80
	// ErrGroupMaxSizeReached Broker: Consumer group has reached maximum size
	ErrGroupMaxSizeReached ErrorCode = 81
	// ErrFencedInstanceID Broker: Static consumer fenced by other consumer with same group.instance.id
	ErrFencedInstanceID ErrorCode = 82
	// ErrEligibleLeadersNotAvailable Broker: Eligible partition leaders are not available
	ErrEligibleLeadersNotAvailable ErrorCode = 83
	// ErrElectionNotNeeded Broker: Leader election not needed for topic partition
	ErrElectionNotNeeded ErrorCode = 84
	// ErrNoReassignmentInProgress Broker: No partition reassignment is in progress
	ErrNoReassignmentInProgress ErrorCode = 85
	// ErrGroupSubscribedToTopic Broker: Deleting offsets of a topic while the consumer group is subscribed to it
	ErrGroupSubscribedToTopic ErrorCode = 86
	// ErrInvalidRecord Broker: Broker failed to validate record
	ErrInvalidRecord ErrorCode = 87
	// ErrUnstableOffsetCommit Broker: There are unstable offsets that need to be cleared
	ErrUnstableOffsetCommit ErrorCode = 88
	// ErrThrottlingQuotaExceeded Broker: Throttling quota has been exceeded
	ErrThrottlingQuotaExceeded ErrorCode = 89
	// ErrProducerFenced Broker: There is a newer producer with the same transactionalId which fences the current one
	ErrProducerFenced ErrorCode = 90
	// ErrResourceNotFound Broker: Request illegally referred to resource that does not exist
	ErrResourceNotFound ErrorCode = 91
	// ErrDuplicateResource Broker: Request illegally referred to the same resource twice
	ErrDuplicateResource ErrorCode = 92
	// ErrUnacceptableCredential Broker: Requested credential would not meet criteria for acceptability
	ErrUnacceptableCredential ErrorCode = 93
	// ErrInconsistentVoterSet Broker: Indicates that the either the sender or recipient of a voter-only request is not one of the expected voters
	ErrInconsistentVoterSet ErrorCode = 94
	// ErrInvalidUpdateVersion Broker: Invalid update version
	ErrInvalidUpdateVersion ErrorCode = 95
	// ErrFeatureUpdateFailed Broker: Unable to update finalized features due to server error
	ErrFeatureUpdateFailed ErrorCode = 96
	// ErrPrincipalDeserializationFailure Broker: Request principal deserialization failed during forwarding
	ErrPrincipalDeserializationFailure ErrorCode = 97
	// ErrUnknownTopicID Broker: Unknown topic id
	ErrUnknownTopicID ErrorCode = 100
	// ErrInconsistentTopicID Broker: The log's topic ID did not match the topic ID in the request
	ErrInconsistentTopicID ErrorCode = 103
	// ErrFencedMemberEpoch Broker: The member epoch is fenced by the group coordinator
	ErrFencedMemberEpoch ErrorCode = 110
	// ErrUnreleasedInstanceID Broker: The instance ID is still used by another member in the consumer group
	ErrUnreleasedInstanceID ErrorCode = 111
	// ErrUnsupportedAssignor Broker: The assignor or its version range is not supported by the consumer group
	ErrUnsupportedAssignor ErrorCode = 112
	// ErrStaleMemberEpoch Broker: The member epoch is stale
	ErrStaleMemberEpoch ErrorCode = 113
	// ErrMismatchedEndpointType Broker: The request was sent to an endpoint of the wrong type
	ErrMismatchedEndpointType ErrorCode = 114
	// ErrUnsupportedEndpointType Broker: This endpoint type is not supported yet
	ErrUnsupportedEndpointType ErrorCode = 115
	// ErrUnknownControllerID Broker: This controller ID is not known
	ErrUnknownControllerID ErrorCode = 116
	// ErrUnknownSubscriptionID Broker: Client sent a push telemetry request with an invalid or outdated subscription ID
	ErrUnknownSubscriptionID ErrorCode = 117
	// ErrTelemetryTooLarge Broker: Client sent a push telemetry request larger than the maximum size the broker will accept
	ErrTelemetryTooLarge ErrorCode = 118
	// ErrInvalidRegistration Broker: The controller has considered the broker registration to be invalid
	ErrInvalidRegistration ErrorCode = 119
	// ErrTransactionAbortable Broker: The server encountered an error with the transaction
	ErrTransactionAbortable ErrorCode = 120
	// ErrInvalidRecordState Broker: The record state is invalid
	ErrInvalidRecordState ErrorCode = 121
	// ErrShareSessionNotFound Broker: The share session was not found
	ErrShareSessionNotFound ErrorCode = 122
	// ErrInvalidShareSessionEpoch Broker: The share session epoch is invalid
	ErrInvalidShareSessionEpoch ErrorCode = 123
	// ErrFencedStateEpoch Broker: The share-group state epoch did not match
	ErrFencedStateEpoch ErrorCode = 124
	// ErrInvalidVoterKey Broker: The voter key doesn't match the receiving replica's key
	ErrInvalidVoterKey ErrorCode = 125
	// ErrDuplicateVoter Broker: The voter is already part of the set of voters
	ErrDuplicateVoter ErrorCode = 126
	// ErrVoterNotFound Broker: The voter is not part of the set of voters
	ErrVoterNotFound ErrorCode = 127
	// ErrInvalidRegularExpression Broker: The regular expression is not valid
	ErrInvalidRegularExpression ErrorCode = 128
	// ErrRebootstrapRequired Broker: Client metadata is stale, client should rebootstrap to obtain new metadata
	ErrRebootstrapRequired ErrorCode = 129
	// ErrStreamsInvalidTopology Broker: The supplied topology is invalid
	ErrStreamsInvalidTopology ErrorCode = 130
	// ErrStreamsInvalidTopologyEpoch Broker: The supplied topology epoch is invalid
	ErrStreamsInvalidTopologyEpoch ErrorCode = 131
	// ErrStreamsTopologyFenced Broker: The supplied topology epoch is outdated
	ErrStreamsTopologyFenced ErrorCode = 132
	// ErrShareSessionLimitReached Broker: The limit of share sessions has been reached
	ErrShareSessionLimitReached ErrorCode = 133
)

var errorStrings = map[ErrorCode]string{
	ErrBadMsg:                             "Local: Bad message format",
	ErrBadCompression:                     "Local: Invalid compressed data",
	ErrDestroy:                            "Local: Broker handle destroyed for termination",
	ErrFail:                               "Local: Communication failure with broker",
	ErrTransport:                          "Local: Broker transport failure",
	ErrCritSysResource:                    "Local: Critical system resource failure",
	ErrResolve:                            "Local: Host resolution failure",
	ErrMsgTimedOut:                        "Local: Message timed out",
	ErrPartitionEOF:                       "Broker: No more messages",
	ErrUnknownPartition:                   "Local: Unknown partition",
	ErrFs:                                 "Local: File or filesystem error",
	ErrUnknownTopic:                       "Local: Unknown topic",
	ErrAllBrokersDown:                     "Local: All broker connections are down",
	ErrInvalidArg:                         "Local: Invalid argument or configuration",
	ErrTimedOut:                           "Local: Timed out",
	ErrQueueFull:                          "Local: Queue full",
	ErrIsrInsuff:                          "Local: ISR count insufficient",
	ErrNodeUpdate:                         "Local: Broker node update",
	ErrSsl:                                "Local: SSL error",
	ErrWaitCoord:                          "Local: Waiting for coordinator",
	ErrUnknownGroup:                       "Local: Unknown group",
	ErrInProgress:                         "Local: Operation in progress",
	ErrPrevInProgress:                     "Local: Previous operation in progress",
	ErrExistingSubscription:               "Local: Existing subscription",
	ErrAssignPartitions:                   "Local: Assign partitions",
	ErrRevokePartitions:                   "Local: Revoke partitions",
	ErrConflict:                           "Local: Conflicting use",
	ErrState:                              "Local: Erroneous state",
	ErrUnknownProtocol:                    "Local: Unknown protocol",
	ErrNotImplemented:                     "Local: Not implemented",
	ErrAuthentication:                     "Local: Authentication failure",
	ErrNoOffset:                           "Local: No offset stored",
	ErrOutdated:                           "Local: Outdated",
	ErrTimedOutQueue:                      "Local: Timed out in queue",
	ErrUnsupportedFeature:                 "Local: Required feature not supported by broker",
	ErrWaitCache:                          "Local: Awaiting cache update",
	ErrIntr:                               "Local: Operation interrupted",
	ErrKeySerialization:                   "Local: Key serialization error",
	ErrValueSerialization:                 "Local: Value serialization error",
	ErrKeyDeserialization:                 "Local: Key deserialization error",
	ErrValueDeserialization:               "Local: Value deserialization error",
	ErrPartial:                            "Local: Partial response",
	ErrReadOnly:                           "Local: Read-only object",
	ErrNoent:                              "Local: No such entry",
	ErrUnderflow:                          "Local: Read underflow",
	ErrInvalidType:                        "Local: Invalid type",
	ErrRetry:                              "Local: Retry operation",
	ErrPurgeQueue:                         "Local: Purged in queue",
	ErrPurgeInflight:                      "Local: Purged in flight",
	ErrFatal:                              "Local: Fatal error",
	ErrInconsistent:                       "Local: Inconsistent state",
	ErrGaplessGuarantee:                   "Local: Gap-less ordering would not be guaranteed if proceeding",
	ErrMaxPollExceeded:                    "Local: Maximum application poll interval (max.poll.interval.ms) exceeded",
	ErrUnknownBroker:                      "Local: Unknown broker",
	ErrNotConfigured:                      "Local: Functionality not configured",
	ErrFenced:                             "Local: This instance has been fenced by a newer instance",
	ErrApplication:                        "Local: Application generated error",
	ErrAssignmentLost:                     "Local: Group partition assignment lost",
	ErrNoop:                               "Local: No operation performed",
	ErrAutoOffsetReset:                    "Local: No offset to automatically reset to",
	ErrLogTruncation:                      "Local: Partition log truncation detected",
	ErrInvalidDifferentRecord:             "Local: an invalid record in the same batch caused the failure of this message too",
	ErrDestroyBroker:                      "Local: Broker handle destroyed without termination",
	ErrUnknown:                            "Unknown broker error",
	ErrNoError:                            "Success",
	ErrOffsetOutOfRange:                   "Broker: Offset out of range",
	ErrInvalidMsg:                         "Broker: Invalid message",
	ErrUnknownTopicOrPart:                 "Broker: Unknown topic or partition",
	ErrInvalidMsgSize:                     "Broker: Invalid message size",
	ErrLeaderNotAvailable:                 "Broker: Leader not available",
	ErrNotLeaderForPartition:              "Broker: Not leader for partition",
	ErrRequestTimedOut:                    "Broker: Request timed out",
	ErrBrokerNotAvailable:                 "Broker: Broker not available",
	ErrReplicaNotAvailable:                "Broker: Replica not available",
	ErrMsgSizeTooLarge:                    "Broker: Message size too large",
	ErrStaleCtrlEpoch:                     "Broker: StaleControllerEpochCode",
	ErrOffsetMetadataTooLarge:             "Broker: Offset metadata string too large",
	ErrNetworkException:                   "Broker: Broker disconnected before response received",
	ErrCoordinatorLoadInProgress:          "Broker: Coordinator load in progress",
	ErrCoordinatorNotAvailable:            "Broker: Coordinator not available",
	ErrNotCoordinator:                     "Broker: Not coordinator",
	ErrTopicException:                     "Broker: Invalid topic",
	ErrRecordListTooLarge:                 "Broker: Message batch larger than configured server segment size",
	ErrNotEnoughReplicas:                  "Broker: Not enough in-sync replicas",
	ErrNotEnoughReplicasAfterAppend:       "Broker: Message(s) written to insufficient number of in-sync replicas",
	ErrInvalidRequiredAcks:                "Broker: Invalid required acks value",
	ErrIllegalGeneration:                  "Broker: Specified group generation id is not valid",
	ErrInconsistentGroupProtocol:          "Broker: Inconsistent group protocol",
	ErrInvalidGroupID:                     "Broker: Invalid group.id",
	ErrUnknownMemberID:                    "Broker: Unknown member",
	ErrInvalidSessionTimeout:              "Broker: Invalid session timeout",
	ErrRebalanceInProgress:                "Broker: Group rebalance in progress",
	ErrInvalidCommitOffsetSize:            "Broker: Commit offset data size is not valid",
	ErrTopicAuthorizationFailed:           "Broker: Topic authorization failed",
	ErrGroupAuthorizationFailed:           "Broker: Group authorization failed",
	ErrClusterAuthorizationFailed:         "Broker: Cluster authorization failed",
	ErrInvalidTimestamp:                   "Broker: Invalid timestamp",
	ErrUnsupportedSaslMechanism:           "Broker: Unsupported SASL mechanism",
	ErrIllegalSaslState:                   "Broker: Request not valid in current SASL state",
	ErrUnsupportedVersion:                 "Broker: API version not supported",
	ErrTopicAlreadyExists:                 "Broker: Topic already exists",
	ErrInvalidPartitions:                  "Broker: Invalid number of partitions",
	ErrInvalidReplicationFactor:           "Broker: Invalid replication factor",
	ErrInvalidReplicaAssignment:           "Broker: Invalid replica assignment",
	ErrInvalidConfig:                      "Broker: Configuration is invalid",
	ErrNotController:                      "Broker: Not controller for cluster",
	ErrInvalidRequest:                     "Broker: Invalid request",
	ErrUnsupportedForMessageFormat:        "Broker: Message format on broker does not support request",
	ErrPolicyViolation:                    "Broker: Policy violation",
	ErrOutOfOrderSequenceNumber:           "Broker: Broker received an out of order sequence number",
	ErrDuplicateSequenceNumber:            "Broker: Broker received a duplicate sequence number",
	ErrInvalidProducerEpoch:               "Broker: Producer attempted an operation with an old epoch",
	ErrInvalidTxnState:                    "Broker: Producer attempted a transactional operation in an invalid state",
	ErrInvalidProducerIDMapping:           "Broker: Producer attempted to use a producer id which is not currently assigned to its transactional id",
	ErrInvalidTransactionTimeout:          "Broker: Transaction timeout is larger than the maximum value allowed by the broker's max.transaction.timeout.ms",
	ErrConcurrentTransactions:             "Broker: Producer attempted to update a transaction while another concurrent operation on the same transaction was ongoing",
	ErrTransactionCoordinatorFenced:       "Broker: Indicates that the transaction coordinator sending a WriteTxnMarker is no longer the current coordinator for a given producer",
	ErrTransactionalIDAuthorizationFailed: "Broker: Transactional Id authorization failed",
	ErrSecurityDisabled:                   "Broker: Security features are disabled",
	ErrOperationNotAttempted:              "Broker: Operation not attempted",
	ErrKafkaStorageError:                  "Broker: Disk error when trying to access log file on disk",
	ErrLogDirNotFound:                     "Broker: The user-specified log directory is not found in the broker config",
	ErrSaslAuthenticationFailed:           "Broker: SASL Authentication failed",
	ErrUnknownProducerID:                  "Broker: Unknown Producer Id",
	ErrReassignmentInProgress:             "Broker: Partition reassignment is in progress",
	ErrDelegationTokenAuthDisabled:        "Broker: Delegation Token feature is not enabled",
	ErrDelegationTokenNotFound:            "Broker: Delegation Token is not found on server",
	ErrDelegationTokenOwnerMismatch:       "Broker: Specified Principal is not valid Owner/Renewer",
	ErrDelegationTokenRequestNotAllowed:   "Broker: Delegation Token requests are not allowed on this connection",
	ErrDelegationTokenAuthorizationFailed: "Broker: Delegation Token authorization failed",
	ErrDelegationTokenExpired:             "Broker: Delegation Token is expired",
	ErrInvalidPrincipalType:               "Broker: Supplied principalType is not supported",
	ErrNonEmptyGroup:                      "Broker: The group is not empty",
	ErrGroupIDNotFound:                    "Broker: The group id does not exist",
	ErrFetchSessionIDNotFound:             "Broker: The fetch session ID was not found",
	ErrInvalidFetchSessionEpoch:           "Broker: The fetch session epoch is invalid",
	ErrListenerNotFound:                   "Broker: No matching listener",
	ErrTopicDeletionDisabled:              "Broker: Topic deletion is disabled",
	ErrFencedLeaderEpoch:                  "Broker: Leader epoch is older than broker epoch",
	ErrUnknownLeaderEpoch:                 "Broker: Leader epoch is newer than broker epoch",
	ErrUnsupportedCompressionType:         "Broker: Unsupported compression type",
	ErrStaleBrokerEpoch:                   "Broker: Broker epoch has changed",
	ErrOffsetNotAvailable:                 "Broker: Leader high watermark is not caught up",
	ErrMemberIDRequired:                   "Broker: Group member needs a valid member ID",
	ErrPreferredLeaderNotAvailable:        "Broker: Preferred leader was not available",
	ErrGroupMaxSizeReached:                "Broker: Consumer group has reached maximum size",
	ErrFencedInstanceID:                   "Broker: Static consumer fenced by other consumer with same group.instance.id",
	ErrEligibleLeadersNotAvailable:        "Broker: Eligible partition leaders are not available",
	ErrElectionNotNeeded:                  "Broker: Leader election not needed for topic partition",
	ErrNoReassignmentInProgress:           "Broker: No partition reassignment is in progress",
	ErrGroupSubscribedToTopic:             "Broker: Deleting offsets of a topic while the consumer group is subscribed to it",
	ErrInvalidRecord:                      "Broker: Broker failed to validate record",
	ErrUnstableOffsetCommit:               "Broker: There are unstable offsets that need to be cleared",
	ErrThrottlingQuotaExceeded:            "Broker: Throttling quota has been exceeded",
	ErrProducerFenced:                     "Broker: There is a newer producer with the same transactionalId which fences the current one",
	ErrResourceNotFound:                   "Broker: Request illegally referred to resource that does not exist",
	ErrDuplicateResource:                  "Broker: Request illegally referred to the same resource twice",
	ErrUnacceptableCredential:             "Broker: Requested credential would not meet criteria for acceptability",
	ErrInconsistentVoterSet:               "Broker: Indicates that the either the sender or recipient of a voter-only request is not one of the expected voters",
	ErrInvalidUpdateVersion:               "Broker: Invalid update version",
	ErrFeatureUpdateFailed:                "Broker: Unable to update finalized features due to server error",
	ErrPrincipalDeserializationFailure:    "Broker: Request principal deserialization failed during forwarding",
	ErrUnknownTopicID:                     "Broker: Unknown topic id",
	ErrInconsistentTopicID:                "Broker: The log's topic ID did not match the topic ID in the request",
	ErrFencedMemberEpoch:                  "Broker: The member epoch is fenced by the group coordinator",
	ErrUnreleasedInstanceID:               "Broker: The instance ID is still used by another member in the consumer group",
	ErrUnsupportedAssignor:                "Broker: The assignor or its version range is not supported by the consumer group",
	ErrStaleMemberEpoch:                   "Broker: The member epoch is stale",
	ErrMismatchedEndpointType:             "Broker: The request was sent to an endpoint of the wrong type",
	ErrUnsupportedEndpointType:            "Broker: This endpoint type is not supported yet",
	ErrUnknownControllerID:                "Broker: This controller ID is not known",
	ErrUnknownSubscriptionID:              "Broker: Client sent a push telemetry request with an invalid or outdated subscription ID",
	ErrTelemetryTooLarge:                  "Broker: Client sent a push telemetry request larger than the maximum size the broker will accept",
	ErrInvalidRegistration:                "Broker: The controller has considered the broker registration to be invalid",
	ErrTransactionAbortable:               "Broker: The server encountered an error with the transaction",
	ErrInvalidRecordState:                 "Broker: The record state is invalid",
	ErrShareSessionNotFound:               "Broker: The share session was not found",
	ErrInvalidShareSessionEpoch:           "Broker: The share session epoch is invalid",
	ErrFencedStateEpoch:                   "Broker: The share-group state epoch did not match",
	ErrInvalidVoterKey:                    "Broker: The voter key doesn't match the receiving replica's key",
	ErrDuplicateVoter:                     "Broker: The voter is already part of the set of voters",
	ErrVoterNotFound:                      "Broker: The voter is not part of the set of voters",
	ErrInvalidRegularExpression:           "Broker: The regular expression is not valid",
	ErrRebootstrapRequired:                "Broker: Client metadata is stale, client should rebootstrap to obtain new metadata",
	ErrStreamsInvalidTopology:             "Broker: The supplied topology is invalid",
	ErrStreamsInvalidTopologyEpoch:        "Broker: The supplied topology epoch is invalid",
	ErrStreamsTopologyFenced:              "Broker: The supplied topology epoch is outdated",
	ErrShareSessionLimitReached:           "Broker: The limit of share sessions has been reached",
}
