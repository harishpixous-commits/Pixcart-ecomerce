import { Suspense } from "react";
import { SignUpForm } from "@/components/auth/auth-forms";
import { PageLoader } from "@/components/ui";

export const metadata = { title: "Create account" };

export default function SignUpPage() {
  return (
    <div className="mx-auto max-w-md py-6">
      <Suspense fallback={<PageLoader />}>
        <SignUpForm />
      </Suspense>
    </div>
  );
}
