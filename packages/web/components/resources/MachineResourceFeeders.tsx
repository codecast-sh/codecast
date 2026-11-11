import { useMachineResourceDeviceIds, useSyncMachineResource } from "../../hooks/useResourceMonitor";

function MachineResourceFeeder({ deviceId }: { deviceId: string }) {
  useSyncMachineResource(deviceId);
  return null;
}

/** The machine report feeders: one per device on the roster, on the sync host
 *  only. The pressure notice and /resources read the rows from the store. */
export function MachineResourceFeeders() {
  const ids = useMachineResourceDeviceIds();
  return <>{ids.map((id) => <MachineResourceFeeder key={id} deviceId={id} />)}</>;
}
