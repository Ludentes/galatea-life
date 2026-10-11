-- Applier 0.15: the undescribed names a device's bridge sent that the applier announced (GA-DESC-19),
-- kept across a restart (GA-PERSIST-1), so a name is announced once. It names no schema (the storage
-- design, *Inside a build*). Never edit this file once applied; add the next one.

-- Keyed by the bridge's own device, not the applier's id: a replacement moving the id to other
-- hardware leaves the old hardware's names with it. Written after the event it records: a crash
-- between the two announces a name twice, never none.
CREATE TABLE undescribed_announced (
  bridge text NOT NULL,
  bridge_device text NOT NULL,
  name text NOT NULL,
  PRIMARY KEY (bridge, bridge_device, name)
);
