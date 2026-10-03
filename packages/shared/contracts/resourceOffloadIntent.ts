export type ResourceOffloadIntent = {
  client_batch_id: string;
  source_device_id: string;
  selections: Array<{ conversation_id: string; session_id: string; destination_id: string; attested: string[] }>;
  wait_for_idle_ms: number;
};

export type ResourceOffloadBatchId = { destination_id: string; batch_id: string };
