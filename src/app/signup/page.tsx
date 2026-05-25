import { SignupForm } from "./SignupForm";

/**
 * Signup is gated: it requires a `session_id` from a completed Stripe
 * Checkout. The id is read here and handed to the client form.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id } = await searchParams;
  return <SignupForm sessionId={session_id ?? ""} />;
}
