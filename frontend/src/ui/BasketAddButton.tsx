import { useBasketActions, useBasketHas } from "@/state";

/** 「＋」加入画师串；已加入时变成「✓」，再点一次移出。names 可以是一位或多位画师。 */
export function BasketAddButton({ names, className }: { names: string[]; className?: string }) {
  const inBasket = useBasketHas(names);
  const { toggle } = useBasketActions();
  if (!names.length) return null;
  return (
    <button
      type="button"
      className={`basket-add${inBasket ? " on" : ""}${className ? ` ${className}` : ""}`}
      title={inBasket ? "已在画师串里，点击移出" : "加入画师串"}
      aria-label={inBasket ? "移出画师串" : "加入画师串"}
      aria-pressed={inBasket}
      onClick={(e) => {
        e.stopPropagation();
        toggle(names);
      }}
    >
      {inBasket ? "✓" : "＋"}
    </button>
  );
}
