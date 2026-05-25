interface EmailInput {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends an email.
 *
 * No email provider is wired up by default, so messages are written to the
 * server console — handy for grabbing password-reset links during local
 * development. To send real email, plug a provider (Resend, SendGrid,
 * nodemailer, …) into the body of this function.
 */
export async function sendEmail({ to, subject, text }: EmailInput): Promise<void> {
  console.log(
    [
      "",
      "──────────────── EMAIL ────────────────",
      `To:      ${to}`,
      `Subject: ${subject}`,
      "",
      text,
      "────────────────────────────────────────",
      "",
    ].join("\n")
  );
}
