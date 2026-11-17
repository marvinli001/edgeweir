import { afterEach, expect, it } from "vitest";
import {
  resolveNodeLocation,
  setNodeLocationDatabase,
} from "../../src/server/services/node-location";

const fixture = "test/fixtures/node-location.mmdb";
const location = {
  address: "8.8.4.4",
  country: "NZ",
  subdivision: "AUK",
  latitude: -36.8,
  longitude: 174.7,
};
afterEach(() => setNodeLocationDatabase(""));

it("keeps current node coordinates and discards locations for an earlier public address", () => {
  expect(resolveNodeLocation(location.address, location)).toEqual(location);
  expect(resolveNodeLocation("1.1.1.1", location)).toBeNull();
  expect(resolveNodeLocation("172.26.5.67", { ...location, address: "172.26.5.67" })).toBeNull();
});

it("fills countries offline for nodes without a local database and stays unknown without a record", () => {
  // Synthetic IPinfo-layout fixture; these records do not describe the real public networks.
  setNodeLocationDatabase(fixture);
  expect(resolveNodeLocation("8.8.4.4", null)).toEqual({
    address: "8.8.4.4",
    country: "JP",
    subdivision: "",
    latitude: null,
    longitude: null,
    source: "ipinfo",
  });
  expect(resolveNodeLocation("1.1.1.1", location)).toMatchObject({
    country: "NZ",
    address: "1.1.1.1",
    latitude: null,
    longitude: null,
  });
  expect(resolveNodeLocation("9.9.9.9", null)).toBeNull();
  expect(resolveNodeLocation("172.26.5.67", null)).toBeNull();
  expect(resolveNodeLocation(location.address, location)).toEqual(location);
});

it("tolerates a missing optional database without disabling node reads", () => {
  setNodeLocationDatabase("test/fixtures/absent-node-location.mmdb");
  expect(resolveNodeLocation("8.8.4.4", null)).toBeNull();
  expect(resolveNodeLocation(location.address, location)).toEqual(location);
});
