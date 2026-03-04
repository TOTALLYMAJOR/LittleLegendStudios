import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Little Legend Studios',
  description: 'MVP workflow for personalized cinematic child story generation'
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>): JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
