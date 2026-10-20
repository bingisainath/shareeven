// src/components/atoms/Avatar.tsx
// A profile photo, or with no photo a person icon (a group icon for groups) on a soft pastel colour.
import React, { useEffect, useState } from 'react';
import { User, Users } from 'lucide-react';
import { resolveMediaUrl } from '../../../utils/media';
import { avatarTone } from '../../../utils/avatarTone';

interface AvatarProps {
  src?: string | null;
  alt?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl';
  online?: boolean;
  className?: string;
  showRing?: boolean; // Purple ring for active/selected state
  group?: boolean; // a group chat: the two-person icon
}

const Avatar: React.FC<AvatarProps> = ({ 
  src, 
  alt = 'Avatar', 
  size = 'md', 
  online = false, 
  className = '',
  showRing = false,
  group = false,
}) => {
  // Fall back to the icon if the photo can't load (e.g. its link expired)
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const photo = !failed ? resolveMediaUrl(src) : null;
  const tone = avatarTone(alt);
  const Icon = group ? Users : User;

  const sizes: Record<string, string> = {
    xs: 'w-6 h-6',
    sm: 'w-8 h-8',
    md: 'w-10 h-10',
    lg: 'w-12 h-12',
    xl: 'w-16 h-16',
    '2xl': 'w-20 h-20',
    '3xl': 'w-28 h-28'
  };

  return (
    <div data-avatar className={`relative inline-block align-middle flex-shrink-0 ${className}`}>
      {/* Purple ring for active/selected state */}
      {showRing && (
        <div className="absolute inset-0 rounded-full bg-primary-600 p-0.5">
          <div className="w-full h-full rounded-full bg-white" />
        </div>
      )}
      
      {/* Avatar image */}
      {photo ? (
        <img
          src={photo}
          onError={() => setFailed(true)}
          alt={alt}
          className={`${sizes[size]} block rounded-full object-cover ${showRing ? 'relative z-10' : ''}`}
        />
      ) : (
        <span
          role="img"
          aria-label={alt}
          style={{ backgroundColor: tone.bg, color: tone.fg }}
          className={`${sizes[size]} rounded-full flex items-center justify-center select-none ${showRing ? 'relative z-10' : ''}`}
        >
          <Icon className="w-[48%] h-[48%]" strokeWidth={1.9} aria-hidden />
        </span>
      )}
      
      {/* Online status indicator */}
      {online && (
        <span className="absolute bottom-0 right-0 block">
          <span className="block w-3 h-3 rounded-full bg-success-500 border-2 border-white" />
        </span>
      )}
    </div>
  );
};

export default Avatar;