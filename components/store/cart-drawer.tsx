"use client"

import { ShoppingCart, Trash2, Plus, Minus, MessageCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useCartStore } from "@/lib/store"
import Image from "next/image"
import { ContinueShoppingButton } from "./continue-shopping-button"
import { useState } from "react"

export function CartDrawer() {
  const { items, removeItem, updateQuantity, getTotalPrice, clearCart, isOpen, closeCart } = useCartStore()
  const [isConfirmationOpen, setIsConfirmationOpen] = useState(false)

  const handleCheckout = () => {
    setIsConfirmationOpen(false)
    const phoneNumber = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER || "5511999999999" // Fallback de segurança
    const message = encodeURIComponent(
      `Olá! Gostaria de finalizar meu pedido:\n\n${items
        .map((item) => `${item.quantity}x ${item.name} - R$ ${(item.price * item.quantity).toFixed(2)}`)
        .join("\n")}\n\nTotal: R$ ${getTotalPrice().toFixed(2)}`
    )
    window.open(`https://wa.me/${phoneNumber}?text=${message}`, "_blank")
  }

  return (
    <>
      <Sheet open={isOpen} onOpenChange={closeCart}>
        <SheetContent className="w-full sm:max-w-md flex flex-col p-0 bg-background text-foreground z-50">
          <SheetHeader className="px-6 py-4 border-b">
            <SheetTitle className="flex items-center gap-2 text-xl font-bold">
              <ShoppingCart className="w-5 h-5" />
              Meu Carrinho
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({items.length} {items.length === 1 ? 'item' : 'itens'})
              </span>
            </SheetTitle>
          </SheetHeader>

          {items.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-2">
                <ShoppingCart className="w-8 h-8 text-muted-foreground" />
              </div>
              <p className="text-lg font-medium">Seu carrinho está vazio</p>
              <p className="text-sm text-muted-foreground max-w-xs">
                Parece que você ainda não adicionou nenhum item. Que tal dar uma olhada nas nossas ofertas?
              </p>
              <ContinueShoppingButton onClick={closeCart} className="h-10 text-sm" />
            </div>
          ) : (
            <>
              <ScrollArea className="flex-1 px-6">
                <div className="py-6 space-y-6">
                  {items.map((item) => (
                    <div key={item.id} className="flex gap-4 group">
                      <div className="relative w-20 h-20 rounded-lg overflow-hidden border bg-muted shrink-0">
                        <Image
                          src={item.image || "/placeholder.svg"}
                          alt={item.name}
                          fill
                          className="object-cover"
                        />
                      </div>
                      <div className="flex-1 flex flex-col justify-between py-0.5">
                        <div className="space-y-1">
                          <h4 className="font-medium text-sm line-clamp-2 leading-tight">
                            {item.name}
                          </h4>
                          <p className="text-xs text-muted-foreground uppercase font-medium">
                            {item.material}
                          </p>
                        </div>
                        <div className="flex items-center justify-between">
                          <p className="font-bold text-sm">
                            R$ {item.price.toFixed(2)}
                          </p>
                          <div className="flex items-center gap-2">
                            <div className="flex items-center border rounded-md shadow-sm h-7 bg-background">
                              <button
                                onClick={() => updateQuantity(item.id, Math.max(0, item.quantity - 1))}
                                className="h-full px-2 hover:bg-muted transition-colors border-r"
                                disabled={item.quantity <= 1}
                              >
                                <Minus className="w-3 h-3" />
                              </button>
                              <span className="w-8 text-center text-xs font-medium">
                                {item.quantity}
                              </span>
                              <button
                                onClick={() => updateQuantity(item.id, item.quantity + 1)}
                                className="h-full px-2 hover:bg-muted transition-colors border-l"
                              >
                                <Plus className="w-3 h-3" />
                              </button>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={() => removeItem(item.id)}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>

              <div className="pt-4 space-y-4 border-t px-6 pb-6 sm:px-8 bg-background">
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span>R$ {getTotalPrice().toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-lg font-bold">
                    <span>Total</span>
                    <span>R$ {getTotalPrice().toFixed(2)}</span>
                  </div>
                </div>

                <div className="space-y-3">
                  <Button
                    className="w-full h-12 text-lg font-bold bg-[#25D366] hover:bg-[#128C7E] text-white shadow-md transition-all active:scale-[0.98]"
                    onClick={() => setIsConfirmationOpen(true)}
                  >
                    <MessageCircle className="w-5 h-5 mr-2" />
                    Finalizar no WhatsApp
                  </Button>

                  <ContinueShoppingButton
                    onClick={closeCart}
                    className="h-10 text-sm"
                  />
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={isConfirmationOpen} onOpenChange={setIsConfirmationOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Confirmação do Pedido</DialogTitle>
            <DialogDescription>
              Verifique os itens do seu pedido antes de finalizar no WhatsApp.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <ScrollArea className="h-[200px] pr-4">
              <div className="space-y-4">
                {items.map((item) => (
                  <div key={item.id} className="flex justify-between items-start text-sm">
                    <div>
                      <span className="font-bold">{item.quantity}x </span>
                      <span>{item.name}</span>
                    </div>
                    <span className="font-medium whitespace-nowrap ml-4">
                      R$ {(item.price * item.quantity).toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
            <div className="flex justify-between items-center mt-6 pt-4 border-t">
              <span className="font-bold text-lg">Total Final</span>
              <span className="font-black text-xl text-primary">R$ {getTotalPrice().toFixed(2)}</span>
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setIsConfirmationOpen(false)}
              className="w-full sm:w-auto"
            >
              Corrigir
            </Button>
            <Button
              className="w-full sm:w-auto bg-[#25D366] hover:bg-[#128C7E] text-white font-bold"
              onClick={handleCheckout}
            >
              Podemos finalizar
              <MessageCircle className="w-4 h-4 ml-2" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
