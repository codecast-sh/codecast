/**
 * The mobile permission card's look, as plain values: the React Native card
 * (mobile/components/PermissionCard.tsx) feeds it to StyleSheet.create. Keys
 * are limited to ones React Native and React DOM share, so padding is spelled
 * per side and numbers are pixels, and a web renderer can spread it into
 * inline styles. `fontFamily` names the RN face.
 */
export const PERMISSION_CARD_STYLE = {
  container: {
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "rgba(251, 191, 36, 0.5)",
    borderRadius: 8,
    padding: 12,
    backgroundColor: "rgba(251, 191, 36, 0.1)",
    marginBottom: 12,
  },
  content: {
    marginBottom: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  indicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#fbbf24",
  },
  title: {
    fontSize: 14,
    fontWeight: "600",
    color: "#e0e0e0",
  },
  toolName: {
    fontSize: 13,
    fontWeight: "600",
    color: "#fbbf24",
    fontFamily: "JetBrainsMono",
    marginBottom: 4,
  },
  argsContainer: {
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    borderRadius: 4,
    padding: 8,
    marginTop: 8,
  },
  argsText: {
    fontSize: 11,
    color: "#999",
    fontFamily: "JetBrainsMono",
  },
  buttonContainer: {
    flexDirection: "row",
    gap: 8,
  },
  button: {
    flex: 1,
    paddingTop: 10,
    paddingBottom: 10,
    paddingLeft: 16,
    paddingRight: 16,
    borderRadius: 6,
    alignItems: "center",
  },
  approveButton: {
    backgroundColor: "#4ade80",
  },
  approveButtonText: {
    color: "#0d1117",
    fontSize: 14,
    fontWeight: "600",
  },
  denyButton: {
    backgroundColor: "#ff6b6b",
  },
  denyButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
} as const;

/** The card's copy, shared so the two renderers cannot drift. */
export const PERMISSION_CARD_COPY = {
  title: "Permission Required",
  approve: "Approve",
  deny: "Deny",
  argsMaxLines: 3,
} as const;
