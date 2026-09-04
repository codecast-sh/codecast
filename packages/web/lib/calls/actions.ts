type CallManager = typeof import("./callManager");

export const joinCall = async (...args: Parameters<CallManager["joinCall"]>) =>
  (await import("./callManager")).joinCall(...args);

export const knockRoom = async (...args: Parameters<CallManager["knockRoom"]>) =>
  (await import("./callManager")).knockRoom(...args);

export const setRoomLock = async (...args: Parameters<CallManager["setRoomLock"]>) =>
  (await import("./callManager")).setRoomLock(...args);

export const startHuddle = async (...args: Parameters<CallManager["startHuddle"]>) =>
  (await import("./callManager")).startHuddle(...args);
