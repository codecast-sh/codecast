type CallManager = typeof import("./callManager");

export const joinCall = async (...args: Parameters<CallManager["joinCall"]>) =>
  (await import("./callManager")).joinCall(...args);

export const knockRoom = async (...args: Parameters<CallManager["knockRoom"]>) =>
  (await import("./callManager")).knockRoom(...args);

export const ringInto = async (...args: Parameters<CallManager["ringInto"]>) =>
  (await import("./callManager")).ringInto(...args);

export const startHuddle = async (...args: Parameters<CallManager["startHuddle"]>) =>
  (await import("./callManager")).startHuddle(...args);

export const acceptInvite = async (...args: Parameters<CallManager["acceptInvite"]>) =>
  (await import("./callManager")).acceptInvite(...args);

export const declineInvite = async (...args: Parameters<CallManager["declineInvite"]>) =>
  (await import("./callManager")).declineInvite(...args);

export const holdRing = async (...args: Parameters<CallManager["holdRing"]>) =>
  (await import("./callManager")).holdRing(...args);

export const releaseRing = async (...args: Parameters<CallManager["releaseRing"]>) =>
  (await import("./callManager")).releaseRing(...args);
