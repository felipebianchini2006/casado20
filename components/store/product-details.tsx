"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { ShoppingCart, CheckCircle, MessageCircle, Truck, ShieldCheck, Clock, ChevronRight, Home } from "lucide-react"
import { useCartStore } from "@/lib/store"
import type { Product } from "@/lib/types"
import { cn } from "@/lib/utils"
import { ProductImageGallery } from "@/components/store/product-image-gallery"
import { QuantitySelector } from "@/components/ui/quantity-selector"
import Link from "next/link"

interface ProductDetailsProps {
  product: Product
  children?: React.ReactNode
}

export function ProductDetails({ product, children }: ProductDetailsProps) {
  const { addItem } = useCartStore()
  const [isAdding, setIsAdding] = useState(false)
  const [quantity, setQuantity] = useState(1)

  const handleAddToCart = () => {
    setIsAdding(true)
    for (let i = 0; i < quantity; i++) {
      addItem(product)
    }
    setTimeout(() => setIsAdding(false), 1500)
  }

  const whatsappMessage = `Olá! Tenho interesse no produto: ${product.name} (Ref: ${product.ref || product.id}). Pode me ajudar?`
  const whatsappUrl = `https://wa.me/${process.env.NEXT_PUBLIC_WHATSAPP_NUMBER || '5599996510070'}?text=${encodeURIComponent(whatsappMessage)}`

  const discount = product.originalPrice
    ? Math.round(((product.originalPrice - product.price) / product.originalPrice) * 100)
    : 0

  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-2 text-[13px] text-muted-foreground/80 mb-2 overflow-x-auto whitespace-nowrap pb-2 border-b border-border/40">
        <Link href="/" className="hover:text-primary transition-colors flex items-center gap-1 cursor-pointer">
          <Home className="w-3.5 h-3.5" />
          Início
        </Link>
        <ChevronRight className="w-3 h-3 shrink-0 opacity-40" />
        <span className="hover:text-primary cursor-pointer transition-colors capitalize">{product.category}</span>
        <ChevronRight className="w-3 h-3 shrink-0 opacity-40" />
        <span className="text-foreground font-medium truncate">{product.name}</span>
      </nav>

      {/* Main Layout Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 relative">

        {/* Left & Center: Content Area (7/12 - ~58%) */}
        <div className="lg:col-span-7 flex flex-col gap-8">
          <div className="bg-white dark:bg-card rounded-2xl p-4 lg:p-10 border shadow-sm">
            <ProductImageGallery product={product} />
          </div>

          {/* Description/Features Space (can be expanded later) */}
          <div className="flex flex-col gap-4">
            {children}
          </div>
        </div>

        {/* Right: Sticky Side Card (5/12 - ~42%) */}
        <div className="lg:col-span-5 h-fit lg:sticky lg:top-24">
          <div className="flex flex-col gap-6 bg-white dark:bg-card rounded-2xl p-6 lg:p-8 border shadow-lg border-primary/10">
            {/* Stock status - Smaller & subtle */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground bg-muted px-2 py-0.5 rounded">ITEM {product.stock > 0 ? 'EM ESTOQUE' : 'INDISPONÍVEL'}</span>
            </div>

            {/* Product Title - Semi-bold & Elegant */}
            <div className="space-y-2">
              <h1 className="text-xl lg:text-2xl font-semibold tracking-tight text-foreground leading-snug">
                {product.name}
              </h1>
              <p className="text-[11px] text-muted-foreground font-mono">ID: {product.ref || product.id}</p>
            </div>

            {/* Price Selection - Professional Layout */}
            <div className="flex flex-col gap-1 py-6 border-y border-border/50">
              {product.originalPrice && (
                <span className="text-sm text-muted-foreground line-through decoration-destructive/30 opacity-70">
                  R$ {product.originalPrice.toFixed(2)}
                </span>
              )}
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-bold text-foreground tracking-tight">
                  R$ {product.price.toFixed(2)}
                </span>
                <span className="bg-secondary text-secondary-foreground text-[10px] font-black px-1.5 py-0.5 rounded-sm uppercase">PROMOÇÃO</span>
              </div>
              <p className="text-[12px] text-muted-foreground font-medium mt-1">no Pix com 5% de desconto</p>

              {/* Reforço de Entrega */}
              <div className="mt-4 p-3 bg-emerald-50 rounded-xl border border-emerald-100 flex items-center gap-3">
                <Truck className="w-5 h-5 text-emerald-600" />
                <div className="flex flex-col">
                  <span className="text-[13px] font-black text-emerald-800 uppercase tracking-tight">Entrega Grátis Hoje</span>
                  <span className="text-[10px] text-emerald-600 font-bold">Pedidos realizados até às 15h</span>
                </div>
              </div>
            </div>

            {/* Buy Section */}
            <div className="space-y-6">
              {/* Quantity Selection */}
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Quantidade</label>
                <QuantitySelector
                  quantity={quantity}
                  onChange={setQuantity}
                  max={product.stock}
                  className="h-10"
                />
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col gap-3">
                <Button
                  size="xl"
                  onClick={handleAddToCart}
                  disabled={product.stock === 0 || isAdding}
                  className={cn(
                    "w-full font-bold text-lg h-16 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/10 transition-all active:scale-95 border-none",
                    isAdding && "bg-green-600 hover:bg-green-700 shadow-green-600/10"
                  )}
                >
                  {isAdding ? (
                    <>
                      <CheckCircle className="w-6 h-6 mr-2 animate-in zoom-in" />
                      Adicionado!
                    </>
                  ) : (
                    <>
                      <ShoppingCart className="w-6 h-6 mr-2" />
                      Comprar agora
                    </>
                  )}
                </Button>
              </div>

              {/* Trust Section */}
              <div className="space-y-4 pt-4">
                <div className="flex items-start gap-4">
                  <ShieldCheck className="w-5 h-5 text-primary mt-0.5" />
                  <div>
                    <p className="text-[13px] font-bold text-primary">Compra Garantida</p>
                    <p className="text-[11px] text-muted-foreground">Receba o produto que está esperando ou devolvemos o seu dinheiro.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
