/**
 * channels 模块出口
 */
export { Hl7Server, type Hl7ServerOptions, type Hl7ServerStopOptions, type SummarySink } from './Hl7Server.js';

// —— T16 入站背压 ——
export {
  TokenBucket,
  BoundedQueue,
  BackpressureGate,
  RATE_LIMITED_ERROR_CODE,
  type TokenBucketOptions,
  type QuotaConfig,
  type BackpressureOptions,
  type GateMetrics,
  type AcceptResult,
  type RateLimitDlq,
} from './backpressure.js';
export { ChannelSupervisor, DEFAULT_BACKOFF_MS } from './supervisor.js';
export {
  Hl7Connection,
  parseHl7Message,
  buildAck,
  formatHl7Timestamp,
  type Hl7ConnectionOptions,
  type Hl7Message,
  type Hl7ParseOutcome,
  type ParsedAck,
} from './Hl7Connection.js';
export {
  DLQ,
  DlqQueue,
  getDLQ,
  _resetDLQSingleton,
  type DlqEntry,
  type DlqEnqueueInput,
  type DlqQueryOpts,
  type DlqReplayStatus,
  type DlqReplayHandler,
  type DlqReplayResult,
  type DlqPurgeResult,
} from './DLQ.js';
export * from './constants.js';

// —— H1 多协议字段化（T4）——
export {
  type ByteStreamBodyEncoding,
  type ByteSequenceRule,
  type ByteStreamConfig,
  defaultByteStreamConfig,
  parseByteSequence,
  formatByteSequence,
  splitParamEntries,
  parseAutoRespondRules,
  parseByteSequences,
  parseKeepControlChars,
  parseBodyEncoding,
  ByteSequenceMatcher,
  filterMessageBytes,
  buildByteStreamConfig,
  decodeBody,
} from './bytestream.js';

export {
  ByteStreamChannel,
  ByteStreamChannelConnection,
  type ByteStreamChannelOptions,
  type ByteStreamServerStopOptions,
  type FramedMessage,
} from './ByteStreamChannel.js';

export {
  SerialPortChannel,
  defaultSerialPortFactory,
  type MinimalSerialPort,
  type SerialPortFactory,
  type SerialPortChannelOptions,
  type SerialFramedMessage,
} from './SerialPortChannel.js';

export {
  type PrivateBytesFieldEncoding,
  type PrivateBytesField,
  type PrivateBytesConfig,
  type PrivateBytesParseResult,
  type PrivateBytesYamlInput,
  parseHexByte,
  decodeField,
  buildPrivateBytesConfig,
  PrivateBytesParser,
} from './private-bytes.js';

export {
  type LoadOptions,
  type LoadedChannel,
  type PrivateChannelHandle,
  type ChannelLoadError,
  type LoadChannelsOptions,
  type LoadChannelsResult,
  type Hl7YamlConfig,
  type ByteStreamYamlConfig,
  type PrivateYamlConfig,
  type ChannelYamlConfig,
  loadChannelYaml,
  buildHl7Server,
  buildByteStreamConfig as buildByteStreamConfigFromYaml,
  buildPrivateChannelHandle,
  loadAllChannels,
  loadAllChannelsWithReport,
  schemas,
} from './channel-loader.js';

export {
  ChannelRegistry,
  type ChannelHealth,
  type ChannelStatus,
  type ChannelRegistryOptions,
} from './registry.js';
