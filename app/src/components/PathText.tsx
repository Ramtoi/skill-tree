import { Fragment, type HTMLAttributes } from "react";

interface PathTextProps extends HTMLAttributes<HTMLSpanElement> {
	/** The path to render. Full value goes on `title` unless one is given. */
	path: string;
}

/**
 * A file path that wraps after its separators, so a long path breaks at
 * `/` boundaries and the filename stays whole. Pair with `.kv-static[data-wrap]`
 * inside a `.kv-row`, or any container that allows wrapping.
 */
export function PathText({ path, title, ...rest }: PathTextProps) {
	const parts = path.split("/");
	return (
		<span title={title ?? path} {...rest}>
			{parts.map((seg, i) => (
				<Fragment key={i}>
					{seg}
					{i < parts.length - 1 && (
						<>
							/<wbr />
						</>
					)}
				</Fragment>
			))}
		</span>
	);
}
