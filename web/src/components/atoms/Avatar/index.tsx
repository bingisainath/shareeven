// src/components/atoms/Avatar.tsx
import React, { useEffect, useState } from 'react';
import { initials as initialsOf } from '../../../utils/initials';
import { resolveMediaUrl } from '../../../utils/media';

// Initials sit on one of these, picked from the name, so a person keeps the same colour everywhere
const TONES = [
  'from-[#7964a6] to-[#4b376e]', // purple
  'from-[#cf8490] to-[#9b4e5a]', // rose
  'from-[#e1a34b] to-[#a75a13]', // amber
  'from-[#5c91c9] to-[#36618d]', // blue
  'from-[#51a676] to-[#27714a]', // green
  'from-[#8995a8] to-[#586477]', // slate
];

export function toneFor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return TONES[Math.abs(hash) % TONES.length];
}

interface AvatarProps {
  src?: string | null;
  alt?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl';
  online?: boolean;
  className?: string;
  showRing?: boolean; // Purple ring for active/selected state
}

const Avatar: React.FC<AvatarProps> = ({ 
  src, 
  alt = 'Avatar', 
  size = 'md', 
  online = false, 
  className = '',
  showRing = false 
}) => {
  // Fall back to initials if the photo can't load (e.g. its link expired)
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  // Initials are drawn here (no third-party avatar service sees people's names)
  const initials = initialsOf(alt); // emoji and Indian scripts stay whole
  const photo = !failed ? resolveMediaUrl(src) : null;

  const textSizes: Record<string, string> = {
    xs: 'text-[10px]', sm: 'text-xs', md: 'text-sm', lg: 'text-base', xl: 'text-xl', '2xl': 'text-2xl', '3xl': 'text-3xl',
  };

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
          className={`${sizes[size]} ${textSizes[size]} rounded-full bg-gradient-to-br ${toneFor(alt)} text-white font-bold tracking-tight flex items-center justify-center select-none ${showRing ? 'relative z-10' : ''}`}
        >
          {initials}
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