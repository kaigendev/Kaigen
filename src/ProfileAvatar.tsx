export type ProfileAvatarState = "neutral" | "online" | "away" | "busy" | "offline" | "connecting";

type Props = {
  src?: string | null;
  initial: string;
  state?: ProfileAvatarState;
  connecting?: boolean;
  className?: string;
  alt?: string;
};

export default function ProfileAvatar({
  src,
  initial,
  state = "neutral",
  connecting = false,
  className = "",
  alt = "",
}: Props) {
  return <span className={`profile-avatar-frame profile-avatar-${state} ${className}`.trim()}>
    <span className="profile-avatar-clip">
      {src ? <img src={src} alt={alt} /> : <span className="profile-avatar-initial" aria-hidden="true">{initial}</span>}
    </span>
    {connecting && <i className="connection-led" aria-hidden="true" />}
  </span>;
}
