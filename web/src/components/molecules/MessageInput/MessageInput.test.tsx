import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import MessageInput from '.';

beforeAll(() => {
  (URL as any).createObjectURL = jest.fn(() => 'blob:preview');
  (URL as any).revokeObjectURL = jest.fn();
});

const paste = (files: File[], text = '') =>
  fireEvent.paste(screen.getByLabelText('Message'), { clipboardData: { files, getData: () => text, types: files.length ? ['Files'] : ['text/plain'] } });

it('pasting a screenshot attaches it, ready for a caption', () => {
  const onSend = jest.fn();
  render(<MessageInput onSend={onSend} />);
  paste([new File(['png'], 'image.png', { type: 'image/png' })]);
  expect(screen.getByLabelText('Message')).toHaveAttribute('placeholder', 'Add a caption…');
  fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
  expect(onSend.mock.calls[0][1][0].file.name).toBe('image.png');
  expect(onSend.mock.calls[0][1][0].quality).toBe('standard'); // sent as a photo
});

it('a pasted PDF goes as a document', () => {
  const onSend = jest.fn();
  render(<MessageInput onSend={onSend} />);
  paste([new File(['%PDF'], 'bill.pdf', { type: 'application/pdf' })]);
  fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
  expect(onSend.mock.calls[0][1][0].quality).toBe('original'); // sent as a document, untouched
});

it('pasting text is left to the browser, and nothing is attached', () => {
  render(<MessageInput onSend={jest.fn()} />);
  paste([], 'hello');
  expect(screen.getByLabelText('Message')).toHaveAttribute('placeholder', 'Type a message...');
});

it("nothing can be pasted in a chat that can't take messages", () => {
  render(<MessageInput onSend={jest.fn()} messagesDisabled />);
  expect(screen.getByLabelText('Message')).toBeDisabled();
});
