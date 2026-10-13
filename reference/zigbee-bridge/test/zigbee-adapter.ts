import { Zcl, Zdo } from "zigbee-herdsman";
import { Entity } from "zigbee-herdsman/dist/controller/model/entity.js";

/**
 * herdsman's adapter, stubbed (spike S8): herdsman's own `Endpoint` and `Request` run as they do, and
 * every frame they hand to the adapter is recorded and answered as a test says, without a
 * coordinator. Answers are made by herdsman's own ZCL.
 */

/** A frame herdsman handed to the adapter, with the arguments it passed. */
export interface Handed {
  ieee: string;
  endpoint: number;
  cluster: string;
  command: string;
  payload: unknown;
  timeout: number;
  disableResponse: boolean;
  disableRecovery: boolean;
}

/** A ZDO request herdsman handed to the adapter (a bind, plan 2c-3): its cluster id. */
export interface HandedZdo {
  ieee: string;
  clusterId: number;
}

/** What the stub answers a frame with: a payload as the adapter gives it, an error it throws, or nothing (no answer awaited). */
export type Answering = (frame: Zcl.Frame) => unknown;

/** The answer to `req`, as the device would send it: a global `command` (`defaultRsp`, `writeRsp`, `readRsp`) or the cluster's own. */
export function reply(req: Zcl.Frame, command: string, payload: unknown, global = true) {
  const f = Zcl.Frame.create(global ? Zcl.FrameType.GLOBAL : Zcl.FrameType.SPECIFIC, Zcl.Direction.SERVER_TO_CLIENT, true, undefined,
    req.header.transactionSequenceNumber, command, req.cluster.name, payload as never, {});
  const data = f.toBuffer();
  return { clusterID: f.cluster.ID, header: Zcl.Header.fromBuffer(data), data, address: 1, endpoint: 1, linkquality: 100, groupID: 0,
    wasBroadcast: false, destinationEndpoint: 1 };
}

/** A Default Response to `req` with `status`. */
export const defaultResponse = (req: Zcl.Frame, status: number = Zcl.Status.SUCCESS) =>
  reply(req, "defaultRsp", { cmdId: req.command.ID, statusCode: status });

/** The stub, injected into herdsman's models until `restore`; it answers every frame a Default Response SUCCESS until told otherwise. */
export function stubAdapter() {
  const handed: Handed[] = [];
  const zdo: HandedZdo[] = [];
  let answering: Answering = (f) => defaultResponse(f);
  let zdoStatus: number | Error = Zdo.Status.SUCCESS;
  const adapter = {
    hasZdoMessageOverhead: false,
    async sendZdo(ieee: string, _nwk: number, clusterId: number) {
      zdo.push({ ieee, clusterId });
      if (zdoStatus instanceof Error) throw zdoStatus;
      return [zdoStatus, undefined];
    },
    async sendZclFrameToEndpoint(ieee: string, _nwk: number, endpoint: number, frame: Zcl.Frame, timeout: number, disableResponse: boolean,
      disableRecovery: boolean) {
      handed.push({ ieee, endpoint, cluster: frame.cluster.name, command: frame.command.name, payload: frame.payload, timeout, disableResponse,
        disableRecovery });
      const r = await answering(frame);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  Entity.injectAdapter(adapter as never);
  return {
    handed,
    zdo,
    answer(a: Answering): void {
      answering = a;
    },
    /** What a ZDO request (a bind) gets: a status, or an error thrown. */
    answerZdo(status: number | Error): void {
      zdoStatus = status;
    },
    restore(): void {
      Entity.injectAdapter(undefined as never);
    },
  };
}

/** The Z-Stack status codes herdsman names in a failed data confirm (its `ZnpCommandStatus`). */
const ZNP_STATUS: Record<string, number> = { MAC_NO_ACK: 0xe9, NWK_NO_ROUTE: 0xcd, MAC_TRANSACTION_EXPIRED: 0xf0, APS_NO_ACK: 0xb7,
  MAC_CHANNEL_ACCESS_FAILURE: 0xe1, BUFFER_FULL: 0x11, MAC_NO_RESOURCES: 0x1a };
/**
 * The adapter's error for a delivery the network reported failed, as herdsman 10.10.0's Z-Stack
 * adapter words it (`DataConfirmError`): the status's name and code, or `'TIMEOUT'` where no data
 * confirm came at all.
 */
export const dataConfirmFailure = (status = "MAC_NO_ACK") => new Error(status === "TIMEOUT" ? "Data request failed with error: 'TIMEOUT'"
  : `Data request failed with error: '${status}' (0x${(ZNP_STATUS[status] ?? 0xe9).toString(16)})`);
/** The adapter's error for an answer that never came, as herdsman 10.10.0's cluster waitress words it. */
export const responseTimeout = () => new Error("Timeout after 5000ms [address=4660 endpoint=1 clusterId=6 cmdId=11 tsn=7]");
/** The Z-Stack driver's error for a data request the coordinator itself did not take within 6 s (its SRSP). */
export const srspTimeout = () => new Error("SRSP - AF - dataRequest after 6000ms");
