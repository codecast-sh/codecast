import { memo } from "react";
import { useMachineResourceDeviceIds, useSyncMachineResource } from "../../hooks/useResourceMonitor";

// Memo: HostFeeders re-renders on its own feeds (every client-state echo,
// including each session switch), and a feeder per device rode along.
const MachineResourceFeeder = memo(function MachineResourceFeeder({ deviceId }: { deviceId: string }) {
  useSyncMachineResource(deviceId);
  return null;
});

/** The machine report feeders: one per device on the roster, on the sync host
 *  only. The pressure notice and /resources read the rows from the store. */
export const MachineResourceFeeders = memo(function MachineResourceFeeders() {
  const ids = useMachineResourceDeviceIds();
  return <>{ids.map((id) => <MachineResourceFeeder key={id} deviceId={id} />)}</>;
});
