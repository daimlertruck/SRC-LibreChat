'use client';

import * as React from 'react';
import * as Ariakit from '@ariakit/react';

import { Search, X } from 'lucide-react';

import { cn } from '~/utils';
import { Content, Portal, Root, Trigger } from '@radix-ui/react-popover';
import { MenuItem } from '@ariakit/react';
const ROW_HEIGHT = 36;

type SearchPickerProps<TOption extends { key: string }> = {
  options: TOption[];
  renderOptions: (option: TOption) => React.ReactNode;
  query: string;
  onQueryChange: (query: string) => void;
  onPick: (pickedOption: TOption) => void;
  placeholder?: string;
  inputClassName?: string;
  label: string;
  resetValueOnHide?: boolean;
};

export function SearchPicker<TOption extends { key: string; value: string }>({
  options,
  renderOptions,
  onPick,
  onQueryChange,
  query,
  label,
  inputClassName,
  placeholder = 'Select options...',
  resetValueOnHide = false,
}: SearchPickerProps<TOption>) {
  const [open, setOpen] = React.useState(false);
  const combobox = Ariakit.useComboboxStore({
    // defaultItems: items.map(getItem),
    resetValueOnHide,
    value: query,
    setValue: (value) => {
      onQueryChange(value);
      console.log(value);
    },
  });
  const onPickHandler = (option: TOption) => {
    onQueryChange('');
    onPick(option);
    setOpen(false);
  };

  return (
    <Ariakit.ComboboxProvider
      store={combobox}
      // value={query}
      // open={open}
      // setOpen={setOpen}
      // setValue={(value) => React.startTransition(() => onQueryChange(value))}
    >
      <Ariakit.ComboboxLabel className="label">{label}</Ariakit.ComboboxLabel>
      <div className="py-1.5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-primary" />
          <Ariakit.Combobox
            store={combobox}
            // autoSelect
            placeholder={placeholder}
            className="w-full rounded-md bg-surface-secondary py-2 pl-9 pr-3 text-sm text-text-primary focus:outline-none"
          />
        </div>
      </div>
      {/* <Ariakit.Combobox placeholder="e.g., Bluesky" className="combobox" autoSelect /> */}
      <Ariakit.ComboboxPopover
        gutter={4}
        // sameWidth
        store={combobox}
        unmountOnHide
        className={cn(
          'animate-popover z-50 overflow-hidden rounded-xl border border-border-light bg-surface-secondary shadow-lg',
        )}
      >
        {options.length
          ? options.map((o) => (
              <Ariakit.ComboboxItem
                key={o.key}
                focusOnHover
                hideOnClick
                value={o.value}
                className={cn(
                  'flex w-full cursor-pointer items-center px-3 text-sm',
                  'text-text-primary hover:bg-surface-tertiary',
                  'data-[active-item]:bg-surface-tertiary',
                )}
              >
                {renderOptions(o)}
              </Ariakit.ComboboxItem>
            ))
          : query != '' && <div className={cn()}>No results found</div>}
      </Ariakit.ComboboxPopover>
    </Ariakit.ComboboxProvider>
  );
}
