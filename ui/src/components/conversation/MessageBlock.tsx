interface Props {
  text: string;
}

export function MessageBlock({ text }: Props) {
  return (
    <pre className="whitespace-pre-wrap break-words px-4 py-2 font-sans text-sm text-foreground">
      {text}
    </pre>
  );
}
