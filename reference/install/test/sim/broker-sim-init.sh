#!/bin/sh
# Test only (plan C1, first light simulated): the installation's broker-init.sh, unchanged, with one
# addition for the simulated bridge's test transport (GA-BRIDGE-16), whose control topic
# {root}/test/bridge_sim/control is outside every production grant. `mosquitto` is found first in
# shim/, which appends the test's grants and its control identity, then becomes the real Mosquitto.
set -eu
PATH=/broker-sim/shim:$PATH
export PATH
exec /broker/broker-init.sh
