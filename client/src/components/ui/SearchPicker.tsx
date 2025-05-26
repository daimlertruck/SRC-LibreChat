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
  renderOptions: (option: TOption) => React.ReactElement;
  query: string;
  onQueryChange: (query: string) => void;
  onPick: (pickedOption: TOption) => void;
  placeholder?: string;
  inputClassName?: string;
  label: string;
  resetValueOnHide?: boolean;
  isSmallScreen?: boolean;
};

export function SearchPicker<TOption extends { key: string; value: string }>({
  options,
  renderOptions,
  onPick,
  onQueryChange,
  query,
  label,
  inputClassName,
  isSmallScreen = false,
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
    <Ariakit.ComboboxProvider store={combobox}>
      <Ariakit.ComboboxLabel className="text-token-text-primary mb-2 block font-medium">
        {label}
      </Ariakit.ComboboxLabel>
      <div className="py-1.5">
        <div
          className={cn(
            'group relative mt-1 flex h-10 cursor-pointer items-center gap-3 rounded-lg border-border-medium px-3 py-2 text-text-primary transition-colors duration-200 focus-within:bg-surface-hover hover:bg-surface-hover',
            isSmallScreen === true ? 'mb-2 h-14 rounded-2xl' : '',
          )}
        >
          <Search className="absolute left-3 h-4 w-4 text-text-secondary group-focus-within:text-text-primary group-hover:text-text-primary" />
          <Ariakit.Combobox
            store={combobox}
            // autoSelect
            placeholder={placeholder}
            className="m-0 mr-0 w-full rounded-md border-none bg-surface-secondary bg-transparent p-0 py-2 pl-7 pl-9 pr-3 text-sm leading-tight text-text-primary placeholder-text-secondary placeholder-opacity-100 focus:outline-none focus-visible:outline-none group-focus-within:placeholder-text-primary group-hover:placeholder-text-primary"
          />
        </div>
      </div>
      {/* <Ariakit.Combobox placeholder="e.g., Bluesky" className="combobox" autoSelect /> */}
      <Ariakit.ComboboxPopover
        portal
        gutter={4}
        // sameWidth
        store={combobox}
        unmountOnHide
        className={cn(
          'animate-popover z-[9999] overflow-hidden rounded-xl border border-border-light bg-surface-secondary shadow-lg',
          '[pointer-events:auto]', // Override body's pointer-events:none when in modal
        )}
      >
        {options.length
          ? options.map((o) => (
              <Ariakit.ComboboxItem
                key={o.key}
                focusOnHover
                // hideOnClick
                value={o.value}
                selectValueOnClick
                className={cn(
                  'flex w-full cursor-pointer items-center px-3 text-sm',
                  'text-text-primary hover:bg-surface-tertiary',
                  'data-[active-item]:bg-surface-tertiary',
                )}
                render={renderOptions(o)}
              ></Ariakit.ComboboxItem>
            ))
          : query != '' && <div className={cn()}>No results found</div>}
      </Ariakit.ComboboxPopover>
    </Ariakit.ComboboxProvider>
  );
}
