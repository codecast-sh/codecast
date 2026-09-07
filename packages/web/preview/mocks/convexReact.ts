// convex/react stand-in for the preview: mutations log and answer with the
// shape each panel action reads.
export function useMutation(ref: unknown) {
  return async (args: unknown) => {
    console.log("mutation", String(ref), args);
    await new Promise((r) => setTimeout(r, 400));
    return { batch_id: "mg-preview1", rows: [{}, {}], skipped: [], cancelled: 2, requeued: 1 };
  };
}
