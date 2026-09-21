import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { Header } from "@/components/layout/header";
import { FloatingAIChat } from "@/components/layout/floating-ai-chat";
import { Footer } from "@/components/layout/footer";
import { WebSocketProvider } from "@/contexts/websocket-context";
import { AuthProvider } from "@/contexts/auth-context";
import { AuthGuard } from "@/components/auth/auth-guard";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lounge XRAY Logs",
  description: "Аналитика access-логов Xray в реальном времени",
};

// Prevent zoom on input focus for iOS
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale}>
      <body
        className="antialiased"
      >
        {/* The light the glass refracts, above everything that renders.
            It sits outside AuthGuard on purpose: the login screen is made of
            the same material, and glass with nothing behind it is just a grey
            box. Fixed position, so surfaces reveal different parts of the
            field as the page scrolls. */}
        <div className="ambient-field" aria-hidden="true" />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <AuthProvider>
            <AuthGuard>
              <WebSocketProvider>
                <Header />
                <main className="min-h-[calc(100vh-3.5rem)]">
                  <div className="mx-auto w-full max-w-[1600px]">{children}</div>
                </main>
                <Footer />
                <FloatingAIChat />
              </WebSocketProvider>
            </AuthGuard>
          </AuthProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
