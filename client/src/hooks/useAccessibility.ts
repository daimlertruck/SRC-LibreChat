import { useEffect, useRef, useState, useCallback } from 'react';
import useLocalize from './useLocalize';

interface UseAccessibilityOptions {
  announceChanges?: boolean;
  enableKeyboardNavigation?: boolean;
  enableFocusManagement?: boolean;
  reducedMotion?: boolean;
}

interface AccessibilityState {
  isReducedMotion: boolean;
  isHighContrast: boolean;
  announceToScreenReader: (message: string, priority?: 'polite' | 'assertive') => void;
  manageFocus: (element: HTMLElement | null) => void;
  handleKeyboardNavigation: (event: KeyboardEvent, items: HTMLElement[]) => void;
  generateAriaLabel: (context: string, details?: Record<string, any>) => string;
  getAriaDescribedBy: (elementId: string, descriptions: string[]) => string;
}

/**
 * Custom hook for enhanced accessibility features
 * Provides comprehensive accessibility utilities for components
 */
export function useAccessibility(options: UseAccessibilityOptions = {}): AccessibilityState {
  const {
    announceChanges = true,
    enableKeyboardNavigation = true,
    enableFocusManagement = true,
    reducedMotion = false,
  } = options;

  const localize = useLocalize();
  const [isReducedMotion, setIsReducedMotion] = useState(reducedMotion);
  const [isHighContrast, setIsHighContrast] = useState(false);
  const ariaLiveRef = useRef<HTMLDivElement | null>(null);
  const lastAnnouncementRef = useRef<string>('');
  const focusTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Detect user preferences
  useEffect(() => {
    const mediaQueryReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const mediaQueryHighContrast = window.matchMedia('(prefers-contrast: high)');

    const updateReducedMotion = (e: MediaQueryListEvent) => setIsReducedMotion(e.matches);
    const updateHighContrast = (e: MediaQueryListEvent) => setIsHighContrast(e.matches);

    setIsReducedMotion(mediaQueryReducedMotion.matches);
    setIsHighContrast(mediaQueryHighContrast.matches);

    mediaQueryReducedMotion.addEventListener('change', updateReducedMotion);
    mediaQueryHighContrast.addEventListener('change', updateHighContrast);

    return () => {
      mediaQueryReducedMotion.removeEventListener('change', updateReducedMotion);
      mediaQueryHighContrast.removeEventListener('change', updateHighContrast);
    };
  }, []);

  // Create aria-live region for announcements
  useEffect(() => {
    if (!announceChanges) return;

    const ariaLiveElement = document.createElement('div');
    ariaLiveElement.setAttribute('aria-live', 'polite');
    ariaLiveElement.setAttribute('aria-atomic', 'true');
    ariaLiveElement.style.position = 'absolute';
    ariaLiveElement.style.left = '-10000px';
    ariaLiveElement.style.width = '1px';
    ariaLiveElement.style.height = '1px';
    ariaLiveElement.style.overflow = 'hidden';
    ariaLiveElement.id = 'sources-aria-live';

    document.body.appendChild(ariaLiveElement);
    ariaLiveRef.current = ariaLiveElement;

    return () => {
      if (ariaLiveRef.current && document.body.contains(ariaLiveRef.current)) {
        document.body.removeChild(ariaLiveRef.current);
      }
    };
  }, [announceChanges]);

  // Cleanup focus timeout on unmount
  useEffect(() => {
    return () => {
      if (focusTimeoutRef.current) {
        clearTimeout(focusTimeoutRef.current);
      }
    };
  }, []);

  /**
   * Announce message to screen readers
   */
  const announceToScreenReader = useCallback(
    (message: string, priority: 'polite' | 'assertive' = 'polite') => {
      if (!announceChanges || !ariaLiveRef.current || message === lastAnnouncementRef.current) {
        return;
      }

      lastAnnouncementRef.current = message;
      ariaLiveRef.current.setAttribute('aria-live', priority);
      ariaLiveRef.current.textContent = message;

      // Clear the message after a delay to allow for re-announcements
      setTimeout(() => {
        if (ariaLiveRef.current) {
          ariaLiveRef.current.textContent = '';
        }
        lastAnnouncementRef.current = '';
      }, 1000);
    },
    [announceChanges],
  );

  /**
   * Manage focus for better accessibility
   */
  const manageFocus = useCallback(
    (element: HTMLElement | null) => {
      if (!enableFocusManagement || !element) return;

      // Clear any existing timeout
      if (focusTimeoutRef.current) {
        clearTimeout(focusTimeoutRef.current);
      }

      // Delay focus to ensure element is rendered and visible
      focusTimeoutRef.current = setTimeout(() => {
        try {
          element.focus();

          // Scroll into view if needed
          element.scrollIntoView({
            behavior: isReducedMotion ? 'auto' : 'smooth',
            block: 'nearest',
            inline: 'nearest',
          });
        } catch (error) {
          console.warn('Failed to manage focus:', error);
        }
      }, 100);
    },
    [enableFocusManagement, isReducedMotion],
  );

  /**
   * Handle keyboard navigation for item lists
   */
  const handleKeyboardNavigation = useCallback(
    (event: KeyboardEvent, items: HTMLElement[]) => {
      if (!enableKeyboardNavigation || items.length === 0) return;

      const currentIndex = items.findIndex((item) => item === document.activeElement);
      let nextIndex = currentIndex;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
          break;

        case 'ArrowUp':
          event.preventDefault();
          nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
          break;

        case 'Home':
          event.preventDefault();
          nextIndex = 0;
          break;

        case 'End':
          event.preventDefault();
          nextIndex = items.length - 1;
          break;

        case 'PageDown':
          event.preventDefault();
          nextIndex = Math.min(currentIndex + 5, items.length - 1);
          break;

        case 'PageUp':
          event.preventDefault();
          nextIndex = Math.max(currentIndex - 5, 0);
          break;

        default:
          return;
      }

      if (nextIndex !== currentIndex && items[nextIndex]) {
        manageFocus(items[nextIndex]);
      }
    },
    [enableKeyboardNavigation, manageFocus],
  );

  /**
   * Generate descriptive aria-label for components
   */
  const generateAriaLabel = useCallback(
    (context: string, details: Record<string, any> = {}) => {
      const parts: string[] = [];

      switch (context) {
        case 'source_item':
          parts.push(localize('com_sources_aria_source'));
          if (details.domain) parts.push(`from ${details.domain}`);
          if (details.title) parts.push(`titled ${details.title}`);
          if (details.hasSnippet) parts.push('with preview text');
          break;

        case 'file_item':
          parts.push(localize('com_sources_aria_file'));
          if (details.filename) parts.push(details.filename);
          if (details.size) parts.push(`size ${details.size}`);
          if (details.downloadable) parts.push('downloadable');
          break;

        case 'image_item':
          parts.push(localize('com_sources_aria_image'));
          if (details.alt) parts.push(details.alt);
          if (details.source) parts.push(`from ${details.source}`);
          break;

        case 'download_button':
          parts.push(localize('com_sources_aria_download'));
          if (details.filename) parts.push(details.filename);
          if (details.loading) parts.push('loading');
          break;

        case 'sources_tab':
          parts.push(localize('com_sources_aria_tab'));
          if (details.count) parts.push(`${details.count} items`);
          if (details.active) parts.push('selected');
          break;

        default:
          parts.push(context);
      }

      return parts.join(', ');
    },
    [localize],
  );

  /**
   * Generate aria-describedby attribute value
   */
  const getAriaDescribedBy = useCallback((elementId: string, descriptions: string[]) => {
    if (descriptions.length === 0) return '';

    return descriptions.map((desc, index) => `${elementId}-desc-${index}`).join(' ');
  }, []);

  return {
    isReducedMotion,
    isHighContrast,
    announceToScreenReader,
    manageFocus,
    handleKeyboardNavigation,
    generateAriaLabel,
    getAriaDescribedBy,
  };
}

/**
 * Hook for managing roving tabindex pattern
 */
export function useRovingTabIndex(items: HTMLElement[], activeIndex: number = 0) {
  useEffect(() => {
    items.forEach((item, index) => {
      if (item) {
        item.setAttribute('tabindex', index === activeIndex ? '0' : '-1');
      }
    });
  }, [items, activeIndex]);

  const updateActiveIndex = useCallback(
    (newIndex: number) => {
      if (newIndex >= 0 && newIndex < items.length) {
        items.forEach((item, index) => {
          if (item) {
            item.setAttribute('tabindex', index === newIndex ? '0' : '-1');
          }
        });
      }
    },
    [items],
  );

  return { updateActiveIndex };
}

/**
 * Hook for live region announcements with debouncing
 */
export function useLiveRegion(delay: number = 500) {
  const [announcement, setAnnouncement] = useState<string>('');
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const announce = useCallback(
    (message: string) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        setAnnouncement(message);

        // Clear after announcement
        setTimeout(() => setAnnouncement(''), 1000);
      }, delay);
    },
    [delay],
  );

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return { announcement, announce };
}
