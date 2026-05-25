import { ResetForm } from "./ResetForm";

/** Reads the token + email from the reset link and hands them to the form. */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; email?: string }>;
}) {
  const { token, email } = await searchParams;
  return <ResetForm token={token ?? ""} email={email ?? ""} />;
}
