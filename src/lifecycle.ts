export async function stopServices(
  server: { stop(): void | Promise<void> },
  scheduler: { stop(): Promise<void> },
  store: { close(): void },
): Promise<void> {
  // Both stop signals must be issued before awaiting either drain.
  const schedulerStopped = scheduler.stop();
  const httpStopped = server.stop();
  await Promise.all([schedulerStopped, httpStopped]);
  store.close();
}
