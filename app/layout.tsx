import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./ambient.css";
import Script from "next/script";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ava | The Aurelia Hotel",
  description: "Your thoughtful, always-on concierge at The Aurelia Hotel, Lagos.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Script
          type="module"
          src="https://cdn.spline.design/@splinetool/viewer@2.0.66/build/spline-viewer.js"
          strategy="afterInteractive"
        />
        {children}
      </body>
    </html>
  );
}
