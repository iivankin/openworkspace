export {
  deliveryStatuses,
  type DeliveryStatusName,
  type RecipientDeliveryStatus,
} from "../../shared/mail";

export type MailAddress = {
  address: string;
  name: string | null;
};

export type StoredAttachment = {
  id: string;
  r2Key: string;
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
  disposition: "attachment" | "inline";
  delivery: "attached" | "download_link";
  downloadTokenHash: string | null;
  downloadExpiresAt: number | null;
};

