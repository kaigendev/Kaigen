// Opaque platform bytes validate the Settings handoff; native tests own ZIP semantics.
type ExportCall = { profileId: string; requestedProfileId: string | null; passwordPresent: boolean; passwordCorrect: boolean; status: string };
export const geometryQtoxCalls: ExportCall[] = [];
const replies = new Map<number, (error?: string) => void>();
export const qtoxPayload = (owner: string) => ({
  fileName: owner === "qa-profile-a" ? "alice-qa-🧪-qtox.zip" : "second-qtox.zip",
  bytes: [80, 75, 3, 4, 0, 127, 128, 255, 13, 10, owner === "qa-profile-a" ? 65 : 66],
});
export function geometryResolveQtox(index: number, error?: string) {
  const reply = replies.get(index);
  if (!reply) throw new Error("qTox fixture operation is not pending");
  replies.delete(index); reply(error);
}
export function qtoxFixtureInvoke<T>(args: { profileId?: string; password?: string | null }, active: string, expectedPassword: string | null): Promise<T> {
  const owner = args.profileId ?? active;
  const password = args.password ?? null;
  const call = { profileId: owner, requestedProfileId: args.profileId ?? null, passwordPresent: password !== null,
    passwordCorrect: expectedPassword === null || password === expectedPassword, status: "pending" };
  const index = geometryQtoxCalls.length;
  geometryQtoxCalls.push(call);
  return new Promise<T>((resolve, reject) => {
    replies.set(index, (error) => {
      call.status = error || !call.passwordCorrect ? "rejected" : "resolved";
      if (error || !call.passwordCorrect) reject(new Error(error ?? "PROFILE_PASSWORD_INVALID"));
      else resolve(qtoxPayload(owner) as T);
    });
  });
}
