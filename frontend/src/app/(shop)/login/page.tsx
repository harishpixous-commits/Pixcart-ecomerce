import { Suspense } from "react";
import { SignInForm } from "@/components/auth/auth-forms";
import { AuthFrame } from "@/components/auth/auth-frame";
import { PageLoader } from "@/components/ui";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <AuthFrame>
      <Suspense fallback={<PageLoader />}>
        <SignInForm />
      </Suspense>
    </AuthFrame>
  );
}
