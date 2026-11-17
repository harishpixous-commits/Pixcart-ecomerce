import { Suspense } from "react";
import { PageLoader } from "@/components/ui";
import { OtpLogin } from "./otp-login";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-md py-6">
      <Suspense fallback={<PageLoader />}>
        <OtpLogin />
      </Suspense>
    </div>
  );
}
