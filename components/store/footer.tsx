"use client"

import { Facebook, Instagram, Twitter, MessageCircle } from "lucide-react"
import Image from "next/image"

export function Footer() {
  return (
    <footer className="bg-primary text-primary-foreground py-8 pb-20 md:py-8">
      <div className="container mx-auto px-4">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="bg-black relative w-12 h-12 rounded-full overflow-hidden flex items-center justify-center border-2 border-secondary">
              <Image src="/images/logo.webp" alt="Casa do 20" width={36} height={36} />
            </div>
            <div>
              <h3 className="font-bold text-lg">Casa do 20</h3>
              <p className="text-sm text-primary-foreground/70">
                Conceito em Utilidades para o seu lar
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <a
              href={`https://wa.me/${process.env.NEXT_PUBLIC_WHATSAPP_NUMBER || '5599996510070'}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary-foreground hover:text-secondary transition-colors"
              title="Fale conosco no WhatsApp"
            >
              <MessageCircle className="w-6 h-6" />
            </a>
            <a
              href="#"
              className="text-primary-foreground hover:text-secondary transition-colors"
            >
              <Facebook className="w-6 h-6" />
            </a>
            <a
              href="#"
              className="text-primary-foreground hover:text-secondary transition-colors"
            >
              <Instagram className="w-6 h-6" />
            </a>
            <a
              href="#"
              className="text-primary-foreground hover:text-secondary transition-colors"
            >
              <Twitter className="w-6 h-6" />
            </a>
          </div>
        </div>
        <div className="mt-8 text-center text-sm text-primary-foreground/50 border-t border-primary-foreground/10 pt-6">
          <p>
            &copy; {new Date().getFullYear()} Casa do 20. Todos os direitos
            reservados.
          </p>
        </div>
      </div>
    </footer>
  )
}
