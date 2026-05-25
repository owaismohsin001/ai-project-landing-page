import type { Metadata } from "next";
import "./globals.css";
import { APP_NAME } from "@/lib/config";
import { ThemeProvider } from "@/components/ThemeProvider";

export const metadata: Metadata = {
  title: `${APP_NAME} — Intelligence, delivered.`,
  description: `Build, ship, and scale AI-powered products with ${APP_NAME}.`,
};

// Inlined before hydration so the correct theme class is on <html> before
// any pixels paint — prevents the light→dark (or dark→light) flash.
const noFlashScript = `
  try {
    var t = localStorage.getItem('theme');
    var d = t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (d) document.documentElement.classList.add('dark');
  } catch (e) {}
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      <body className="min-h-screen">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
