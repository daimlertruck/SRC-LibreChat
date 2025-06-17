import { renderHook, act } from '@testing-library/react';
import { useAgentFileDownload } from '../useAgentFileDownload';
import { useAgentSourceDownload } from 'librechat-data-provider';

// Mock dependencies
jest.mock('librechat-data-provider', () => ({
  useAgentSourceDownload: jest.fn(),
}));
jest.mock('../useLocalize');

const mockUseAgentSourceDownload = useAgentSourceDownload as jest.MockedFunction<
  typeof useAgentSourceDownload
>;

describe('useAgentFileDownload', () => {
  const mockMutateAsync = jest.fn();
  const mockOnSuccess = jest.fn();
  const mockOnError = jest.fn();

  beforeEach(() => {
    mockUseAgentSourceDownload.mockReturnValue({
      mutateAsync: mockMutateAsync,
      isLoading: false,
      error: null,
    } as any);

    // Mock DOM methods
    Object.defineProperty(document, 'createElement', {
      value: jest.fn(() => ({
        href: '',
        download: '',
        click: jest.fn(),
        style: {},
      })),
    });

    Object.defineProperty(document.body, 'appendChild', {
      value: jest.fn(),
    });

    Object.defineProperty(document.body, 'removeChild', {
      value: jest.fn(),
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should download file successfully', async () => {
    const mockResponse = {
      downloadUrl: 'https://example.com/file.pdf',
      fileName: 'test.pdf',
    };

    mockMutateAsync.mockResolvedValue(mockResponse);

    const { result } = renderHook(() =>
      useAgentFileDownload({
        conversationId: 'conv-1',
        onSuccess: mockOnSuccess,
        onError: mockOnError,
      }),
    );

    await act(async () => {
      await result.current.downloadFile('file-1', 'msg-1', 'test.pdf');
    });

    expect(mockMutateAsync).toHaveBeenCalledWith({
      fileId: 'file-1',
      messageId: 'msg-1',
      conversationId: 'conv-1',
    });

    expect(mockOnSuccess).toHaveBeenCalledWith('test.pdf');
    expect(mockOnError).not.toHaveBeenCalled();
  });

  it('should handle download errors', async () => {
    const mockError = new Error('Download failed');
    mockMutateAsync.mockRejectedValue(mockError);

    const { result } = renderHook(() =>
      useAgentFileDownload({
        conversationId: 'conv-1',
        onSuccess: mockOnSuccess,
        onError: mockOnError,
      }),
    );

    await act(async () => {
      await result.current.downloadFile('file-1', 'msg-1', 'test.pdf');
    });

    expect(mockOnError).toHaveBeenCalledWith(mockError);
    expect(mockOnSuccess).not.toHaveBeenCalled();
  });

  it('should create download link with correct attributes', async () => {
    const mockResponse = {
      downloadUrl: 'https://example.com/file.pdf',
      fileName: 'response-name.pdf',
    };

    mockMutateAsync.mockResolvedValue(mockResponse);

    const mockLink = {
      href: '',
      download: '',
      click: jest.fn(),
    };

    const mockCreateElement = jest.fn(() => mockLink);
    document.createElement = mockCreateElement;

    const { result } = renderHook(() =>
      useAgentFileDownload({
        conversationId: 'conv-1',
      }),
    );

    await act(async () => {
      await result.current.downloadFile('file-1', 'msg-1', 'original-name.pdf');
    });

    expect(mockCreateElement).toHaveBeenCalledWith('a');
    expect(mockLink.href).toBe('https://example.com/file.pdf');
    expect(mockLink.download).toBe('response-name.pdf');
    expect(mockLink.click).toHaveBeenCalled();
  });

  it('should use fallback filename when response fileName is not provided', async () => {
    const mockResponse = {
      downloadUrl: 'https://example.com/file.pdf',
      // fileName not provided
    };

    mockMutateAsync.mockResolvedValue(mockResponse);

    const mockLink = {
      href: '',
      download: '',
      click: jest.fn(),
    };

    document.createElement = jest.fn(() => mockLink);

    const { result } = renderHook(() =>
      useAgentFileDownload({
        conversationId: 'conv-1',
      }),
    );

    await act(async () => {
      await result.current.downloadFile('file-1', 'msg-1', 'fallback-name.pdf');
    });

    expect(mockLink.download).toBe('fallback-name.pdf');
  });

  it('should return loading state', () => {
    mockUseAgentSourceDownload.mockReturnValue({
      mutateAsync: mockMutateAsync,
      isLoading: true,
      error: null,
    } as any);

    const { result } = renderHook(() =>
      useAgentFileDownload({
        conversationId: 'conv-1',
      }),
    );

    expect(result.current.isLoading).toBe(true);
  });

  it('should return error state', () => {
    const mockError = new Error('Test error');
    mockUseAgentSourceDownload.mockReturnValue({
      mutateAsync: mockMutateAsync,
      isLoading: false,
      error: mockError,
    } as any);

    const { result } = renderHook(() =>
      useAgentFileDownload({
        conversationId: 'conv-1',
      }),
    );

    expect(result.current.error).toBe(mockError);
  });
});
