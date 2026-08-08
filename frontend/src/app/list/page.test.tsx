import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ListPromptPage from "./page";

/**
 * Skenario form U7: tombol submit nonaktif selama in-flight dengan progress
 * upload yang terlihat, dan kegagalan jaringan di tengah submit
 * MEMPERTAHANKAN nilai field lalu menawarkan retry. XHR dipalsukan karena
 * jsdom tidak punya jaringan — dan justru seam itulah (upload.onprogress,
 * onerror) yang ditest.
 */

const CREATOR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CONTENT_HASH = `keccak256:${"ab".repeat(32)}`;
const SIGNATURE = `0x${"cd".repeat(65)}`;

const BODY_TEXT =
  "Design a neon-lit signup flow for a night-market app. Use bold gradients.";

class FakeXHR {
  static instances: FakeXHR[] = [];
  upload: {
    onprogress:
      | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void)
      | null;
  } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  responseText = "";
  openedUrl: string | null = null;
  sentBody: FormData | null = null;

  constructor() {
    FakeXHR.instances.push(this);
  }
  open(_method: string, url: string) {
    this.openedUrl = url;
  }
  send(body: FormData) {
    this.sentBody = body;
  }
}

function jsonResponse(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

function stubListingApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/listings/bounds")) {
      return jsonResponse(200, { minPriceAtomic: "10000", maxPriceAtomic: "10000000" });
    }
    if (url.endsWith("/v1/listings/prepare")) {
      return jsonResponse(200, { contentHash: CONTENT_HASH, teaser: "A teaser." });
    }
    return jsonResponse(404, { error: "not_found", message: `unstubbed ${url}` });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubWallet() {
  const request = vi.fn(async ({ method }: { method: string; params?: unknown[] }) => {
    if (method === "eth_requestAccounts") return [CREATOR];
    if (method === "personal_sign") return SIGNATURE;
    throw new Error(`unexpected wallet method ${method}`);
  });
  (window as { ethereum?: unknown }).ethereum = { request };
  return request;
}

function fillValidForm() {
  fireEvent.change(screen.getByPlaceholderText(/Neon night-market signup flow/), {
    target: { value: "My Neon Prompt" },
  });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "Hero" } });
  fireEvent.change(screen.getByPlaceholderText(/Design a neon-lit signup flow/), {
    target: { value: BODY_TEXT },
  });
  fireEvent.change(screen.getByPlaceholderText("0.25"), { target: { value: "0.50" } });
  const file = new File(["riffbytes"], "preview.webp", { type: "image/webp" });
  fireEvent.change(screen.getByLabelText("Preview media file"), {
    target: { files: [file] },
  });
  fireEvent.click(screen.getByRole("checkbox"));
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /Sign & list prompt|Try again|Preparing|Waiting for wallet|Uploading/,
  }) as HTMLButtonElement;
}

async function submitAndReachUpload(): Promise<FakeXHR> {
  fireEvent.click(submitButton());
  await waitFor(() => expect(FakeXHR.instances.length).toBeGreaterThan(0));
  return FakeXHR.instances[FakeXHR.instances.length - 1];
}

const successEntry = {
  id: "my-neon-prompt",
  title: "My Neon Prompt",
  priceAtomic: "500000",
};

beforeEach(() => {
  FakeXHR.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { ethereum?: unknown }).ethereum;
});

describe("halaman /list — alur submit", () => {
  it("menonaktifkan tombol selama in-flight dan menampilkan progress upload", async () => {
    stubListingApi();
    stubWallet();
    render(<ListPromptPage />);
    fillValidForm();

    const xhr = await submitAndReachUpload();
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().textContent).toContain("Uploading");

    act(() => {
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: 42, total: 100 });
    });
    const bar = screen.getByRole("progressbar", { name: "Upload progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("42");

    act(() => {
      xhr.status = 201;
      xhr.responseText = JSON.stringify(successEntry);
      xhr.onload?.();
    });
    const link = await screen.findByRole("link", { name: "View your listing" });
    expect(link.getAttribute("href")).toBe("/prompts/my-neon-prompt");
  });

  it("kegagalan jaringan mempertahankan nilai field dan retry berhasil", async () => {
    stubListingApi();
    stubWallet();
    render(<ListPromptPage />);
    fillValidForm();

    const first = await submitAndReachUpload();
    act(() => {
      first.onerror?.();
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your entries are kept");

    // Semua isian masih di tempatnya — kreator tidak kehilangan apa pun.
    expect(screen.getByDisplayValue("My Neon Prompt")).toBeTruthy();
    expect(screen.getByDisplayValue(BODY_TEXT)).toBeTruthy();
    expect(screen.getByDisplayValue("0.50")).toBeTruthy();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("Hero");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/preview\.webp/)).toBeTruthy();

    // Tombol menjadi retry dan aktif kembali.
    const retry = submitButton();
    expect(retry.textContent).toContain("Try again");
    expect(retry.disabled).toBe(false);

    fireEvent.click(retry);
    await waitFor(() => expect(FakeXHR.instances.length).toBe(2));
    const second = FakeXHR.instances[1];
    act(() => {
      second.status = 201;
      second.responseText = JSON.stringify(successEntry);
      second.onload?.();
    });
    expect(await screen.findByRole("link", { name: "View your listing" })).toBeTruthy();
  });

  it("tanpa wallet: error bernama, tidak ada permintaan yang terkirim", async () => {
    stubListingApi();
    render(<ListPromptPage />);
    fillValidForm();

    fireEvent.click(submitButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No browser wallet was found");
    expect(FakeXHR.instances).toHaveLength(0);
  });

  it("personal_sign menerima pesan kanonik ber-hash dari prepare, dan kirimannya memuat tanda tangan", async () => {
    stubListingApi();
    const request = stubWallet();
    render(<ListPromptPage />);
    fillValidForm();

    const xhr = await submitAndReachUpload();

    const signCall = request.mock.calls.find(
      ([args]) => (args as { method: string }).method === "personal_sign",
    );
    expect(signCall).toBeTruthy();
    const [hexMessage, signer] = (signCall![0] as unknown as { params: [string, string] })
      .params;
    expect(signer).toBe(CREATOR);
    const message = Buffer.from(hexMessage.slice(2), "hex").toString("utf8");
    expect(message).toContain("promit.listing.v1");
    expect(message).toContain(`contentHash: ${CONTENT_HASH}`);
    expect(message).toContain("priceAtomic: 500000");
    expect(message).toContain("title: My Neon Prompt");

    const sent = xhr.sentBody!;
    expect(sent.get("signature")).toBe(SIGNATURE);
    expect(sent.get("creatorAddress")).toBe(CREATOR);
    expect(sent.get("priceAtomic")).toBe("500000");
    expect(sent.get("media")).toBeInstanceOf(File);
  });

  it("field yang belum lengkap ditolak sebelum wallet atau jaringan disentuh", async () => {
    const fetchMock = stubListingApi();
    stubWallet();
    render(<ListPromptPage />);

    fireEvent.click(submitButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Fix the highlighted fields");
    expect(screen.getByText("Title is required.")).toBeTruthy();
    expect(
      screen.getByText(// Copy now names both routes to a preview, since a link is accepted too.
      "Upload the preview generated by running this prompt, or paste a link to it."),
    ).toBeTruthy();
    // Hanya bounds yang pernah di-fetch; tidak ada prepare, tidak ada XHR.
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.endsWith("/prepare"))).toBe(false);
    expect(FakeXHR.instances).toHaveLength(0);
  });
});
