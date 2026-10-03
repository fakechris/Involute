/** The final authority check is deliberately after all asynchronous preparation. */
export async function executeAuthorizedEffect<T>(input: {
  prepare: () => Promise<void>;
  authorize: () => Promise<void>;
  execute: () => Promise<T>;
}): Promise<T> {
  await input.prepare();
  await input.authorize();
  return input.execute();
}
