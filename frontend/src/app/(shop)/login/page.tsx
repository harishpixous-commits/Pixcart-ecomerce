import { Suspense } from "react";
import { SignInForm } from "@/components/auth/auth-forms";
import { PageLoader } from "@/components/ui";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-md py-6">
      <Suspense fallback={<PageLoader />}>
        <SignInForm />
      </Suspense>
    </div>
  );
}
