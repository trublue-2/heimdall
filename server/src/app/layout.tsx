import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Heimdall",
  description: "Lockbox Control Server",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de" data-theme="user">
      <body className="bg-[var(--background)] text-[var(--foreground)] antialiased">
        {children}
      </body>
    </html>
  );
}
