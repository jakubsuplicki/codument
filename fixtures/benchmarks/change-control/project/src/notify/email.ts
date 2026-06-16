export type Email = { to: string; subject: string; body: string };

export async function sendEmail(email: Email): Promise<{ ok: true }> {
  // Stub transport for the fixture.
  void email;
  return { ok: true };
}

export function welcomeEmail(to: string): Email {
  return { to, subject: "Welcome", body: "Thanks for signing up." };
}
