import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Zcl } from "zigbee-herdsman";
import { Database } from "zigbee-herdsman/dist/controller/database.js";
import * as ZclFrameConverter from "zigbee-herdsman/dist/controller/helpers/zclFrameConverter.js";
import { Device } from "zigbee-herdsman/dist/controller/model/device.js";
import { Entity } from "zigbee-herdsman/dist/controller/model/entity.js";
import { Group } from "zigbee-herdsman/dist/controller/model/group.js";

/**
 * Real herdsman devices for the converters to work on, without a coordinator: rows of herdsman's
 * own database format in a file of their own, and no adapter, so that anything that would send a
 * frame throws instead. Every hardware id is made up; the models are the bench's (their public
 * model and manufacturer strings) and a light and a sensor no database knows.
 */

type Row = Record<string, unknown>;

const endpoint = (inClusters: number[], outClusters: number[] = [], clusters: Record<string, unknown> = {}) =>
  ({ profId: 260, epId: 1, devId: 0, inClusterList: inClusters, outClusterList: outClusters, clusters, binds: [], configuredReportings: [], meta: {} });

const device = (id: number, ieee: string, type: string, modelId: string, manufName: string, powerSource: string, ep: Row, manufId = 4417): Row =>
  ({ id, type, ieeeAddr: ieee, nwkAddr: 1000 + id, manufId, manufName, powerSource, modelId, epList: [1], endpoints: { 1: ep },
    interviewCompleted: true, interviewState: "SUCCESSFUL", meta: {} });

/**
 * A row of a made-up device, for a model the bench does not have: its id (from 10 on), its type,
 * its model and manufacturer strings, its power source, its endpoint's input clusters, and its
 * manufacturer code (4417 unless given).
 */
export const row = (id: number, ieee: string, type: string, modelId: string, manufName: string, powerSource: string, inClusters: number[],
  manufId?: number): Row => device(id, ieee, type, modelId, manufName, powerSource, endpoint(inClusters), manufId);

/** The coordinator: in every database herdsman keeps. */
export const COORDINATOR_ROW: Row = { id: 1, type: "Coordinator", ieeeAddr: "0x00124b0012345678", nwkAddr: 0, manufId: 0, epList: [1],
  endpoints: { 1: endpoint([]) }, interviewCompleted: true, interviewState: "SUCCESSFUL", meta: {} };

/** A vibration sensor, as the bench's TS0210 was interviewed: a sleeping end device with no Poll Control. */
export const SENSOR = "0x00000000000a0001";
export const SENSOR_ROW = device(2, SENSOR, "EndDevice", "TS0210", "_TZ3000_fkxmyics", "Battery", endpoint([1, 1280, 0], [25, 10]));
/** A button pusher, as the bench's Fingerbot Plus was interviewed. */
export const PUSHER = "0x00000000000a0002";
export const PUSHER_ROW = device(3, PUSHER, "EndDevice", "TS0001", "_TZ3210_a04acm9s", "Battery", endpoint([6, 61184, 0], [25, 10]));
/** A dimmable light no model database knows: a router, described by a definition generated from its clusters. */
export const LIGHT = "0x00000000000a0003";
export const LIGHT_ROW = device(4, LIGHT, "Router", "test-light", "galatea-test", "Mains (single phase)", endpoint([0, 3, 4, 5, 6, 8]));
/** A battery sensor no model database knows, with temperature, humidity, occupancy and an IAS zone. */
export const CLIMATE_SENSOR = "0x00000000000a0004";
export const CLIMATE_SENSOR_ROW = device(5, CLIMATE_SENSOR, "EndDevice", "test-sensor", "galatea-test", "Battery",
  endpoint([0, 1, 0x402, 0x405, 0x406, 0x500]));
/** A battery radar presence sensor, as the bench's HOBEIAN ZG-204ZV was interviewed (2026-10-06). */
export const PRESENCE = "0x00000000000a0006";
export const PRESENCE_ROW = device(7, PRESENCE, "EndDevice", "ZG-204ZV", "HOBEIAN", "Battery", endpoint([0, 3, 1280, 61184, 1, 1024]));
/** A door lock no model database knows, its pin-users count already read (so describing it reads nothing). */
export const LOCK = "0x00000000000a0005";
export const LOCK_ROW = device(6, LOCK, "Router", "test-lock", "galatea-test", "Mains (single phase)",
  endpoint([0, 0x101], [], { closuresDoorLock: { attributes: { numOfPinUsersSupported: 10 } } }));

/** A metering smart plug, as the bench's TS011F (_TZ3210_ohifjqrm) was interviewed (2026-10-11): a mains router. */
export const PLUG = "0x00000000000a0007";
export const PLUG_ROW = device(8, PLUG, "Router", "TS011F", "_TZ3210_ohifjqrm", "Mains (single phase)",
  endpoint([0, 3, 4, 5, 6, 0x702, 0xb04, 0xe000, 0xe001], [10, 25]));

/** Opens a herdsman database holding `rows` and the coordinator, as herdsman's own models see it; `close` removes it. */
export function devices(rows: Row[] = [SENSOR_ROW, PUSHER_ROW, LIGHT_ROW]): { get(ieee: string): Device; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), "zigbee-devices-"));
  const file = join(dir, "database.db");
  writeFileSync(file, [COORDINATOR_ROW, ...rows].map((r) => JSON.stringify(r)).join("\n") + "\n");
  Device.resetCache();
  Group.resetCache();
  Entity.injectDatabase(Database.open(file));
  return {
    get(ieee: string): Device {
      const d = Device.byIeeeAddr(ieee);
      if (!d) throw new Error(`no device ${ieee}`);
      return d;
    },
    close(): void {
      Device.resetCache();
      Group.resetCache();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A message from `device`, as herdsman 10.10.0 emits it for a frame it received
 * (`Controller.onZclPayload`): the frame made by herdsman's own ZCL, parsed back from its bytes with
 * the device's custom clusters, a global report or read response as attribute key-values, a
 * cluster command as its payload.
 */
export function message(device: Device, frame: { cluster: string; command: string; payload: unknown; tsn: number; global?: boolean; endpoint?: number }) {
  const made = Zcl.Frame.create(frame.global ? Zcl.FrameType.GLOBAL : Zcl.FrameType.SPECIFIC, Zcl.Direction.SERVER_TO_CLIENT, true, undefined,
    frame.tsn, frame.command, frame.cluster, frame.payload as never, device.customClusters);
  const rawData = made.toBuffer();
  const parsed = Zcl.Frame.fromBuffer(made.cluster.ID, Zcl.Header.fromBuffer(rawData), rawData, device.customClusters);
  const name = parsed.command.name;
  const type = parsed.header.isGlobal ? (name === "report" ? "attributeReport" : name === "readRsp" ? "readResponse" : name)
    : `command${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  const data = parsed.header.isGlobal ? ZclFrameConverter.attributeKeyValue(parsed, device.manufacturerID, device.customClusters) : parsed.payload;
  return { type, device, endpoint: device.getEndpoint(frame.endpoint ?? 1)!, linkquality: 100, groupID: 0, cluster: parsed.cluster.name, data,
    meta: { zclTransactionSequenceNumber: frame.tsn, manufacturerCode: undefined, frameControl: parsed.header.frameControl, rawData } };
}

/** A Tuya datapoint report of `dps` (each its number, its Tuya data type and its bytes). */
export function datapoints(device: Device, tsn: number, dps: [number, number, number[]][]) {
  return message(device, { cluster: "manuSpecificTuya", command: "dataReport", tsn,
    payload: { seq: tsn, dpValues: dps.map(([dp, datatype, data]) => ({ dp, datatype, data: Buffer.from(data) })) } });
}

/** A row with its endpoint's clusters' attributes set, as herdsman caches what a device reported. */
export function withAttributes(row: Row, cluster: string, attributes: Record<string, unknown>): Row {
  const eps = row.endpoints as Record<string, Row>;
  const ep = eps["1"]!;
  const clusters = { ...(ep.clusters as Record<string, unknown>), [cluster]: { attributes } };
  return { ...row, endpoints: { 1: { ...ep, clusters } } };
}
