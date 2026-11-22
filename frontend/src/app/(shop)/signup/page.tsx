import { Suspense } from "react";
import { SignUpForm } from "@/components/auth/auth-forms";
import { AuthFrame } from "@/components/auth/auth-frame";
import { PageLoader } from "@/components/ui";

export const metadata = { title: "Create account" };

export default function SignUpPage() {
  return (
    <AuthFrame>
      <Suspense fallback={<PageLoader />}>
        <SignUpForm />
      </Suspense>
    </AuthFrame>
  );
}
