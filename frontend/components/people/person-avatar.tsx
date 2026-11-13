import { SasaAvatar } from "@/components/ai/sasa-avatar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initials } from "@/lib/names";
import { cn } from "@/lib/utils";

type Person = { image?: string; nameZh?: string; nameEn?: string; name?: string; email?: string; isBot?: boolean };

export function PersonAvatar({ person, className }: { person: Person | null | undefined; className?: string }) {
  if (person?.isBot) return <SasaAvatar className={className} />;
  return (
    <Avatar className={cn("size-8", className)}>
      {person?.image ? <AvatarImage src={person.image} alt="" referrerPolicy="no-referrer" /> : null}
      <AvatarFallback className="bg-secondary text-xs">{initials(person)}</AvatarFallback>
    </Avatar>
  );
}
