// ct-97296: going back to the inbox from Threads. A copy of the harness's own
// "inbox-return" setup (perf/harness.tsx), for trees whose harness predates it. A fragment,
// not a module: perf/inboxReturn.budget.ts appends it to the harness source at
// run time, so it reads the harness's own world (seedStore, measure, cards,
// settle, until, the fake Convex client) and registers one more workload.
//
// The real dashboard shell (src/layouts/DashboardShell: one DashboardLayout
// kept across its routes, with tabs on, as the app runs) over 5,000 cached
// sessions, the session rail open. A run moves the tab to /inbox the way a
// sidebar link does (src/compat/tabRouting tabNavigate) until the inbox's
// board is on screen.
async function setupInboxReturn(): Promise<Bench> {
  const { Routes, Route } = await import("react-router");
  const { default: DashboardShell } = await import("../src/layouts/DashboardShell");
  const { default: InboxPage } = await import("../app/inbox/page");
  const { default: ThreadsPage } = await import("../app/threads/page");
  const { tabNavigate } = await import("../src/compat/tabRouting");
  const { AUTH_JWT_STORAGE_KEY } = await import("../lib/localAuth");
  // The shell draws for a stored token (lib/localAuth), as on a signed-in device.
  w.localStorage.setItem(AUTH_JWT_STORAGE_KEY, "perf");
  seedStore(INBOX_SESSIONS);
  host = w.document.createElement("div");
  w.document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <ConvexProviderWithAuth client={convex} useAuth={useAuth}>
        <MemoryRouter initialEntries={["/threads"]}>
          <Profiler id="perf" onRender={(_id, _phase, actualDuration) => { commits++; renderMs += actualDuration; }}>
            <Routes>
              <Route element={<DashboardShell />}>
                <Route path="inbox" element={<InboxPage />} />
                <Route path="threads" element={<ThreadsPage />} />
              </Route>
            </Routes>
          </Profiler>
        </MemoryRouter>
      </ConvexProviderWithAuth>,
    );
  });
  await settle();
  const onInbox = () => host.textContent!.includes("FLEET");
  const toInbox = async () => { await act(async () => { tabNavigate("/inbox"); }); await until(onInbox, "the inbox to draw"); await settle(); };
  const toThreads = async () => { await act(async () => { tabNavigate("/threads"); }); await settle(); };
  // The first visit opens the session rail (DashboardLayout's route default)
  // and loads the inbox page; every run after is a return to it.
  await toInbox();
  await toThreads();
  return {
    run: async () => {
      const report = await measure(toInbox);
      report.counts.cards = cards();
      return report;
    },
    reset: toThreads,
  };
}
(setups as Record<string, () => Promise<Bench>>)["inbox-return"] = setupInboxReturn;
